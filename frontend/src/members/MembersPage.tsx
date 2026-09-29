import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createStaffMemberSchema,
  staffMemberSchema,
  staffMembersResponseSchema,
  staffScheduleResponseSchema,
  type StaffMember,
  type StaffScheduleEntry
} from "@bussin/shared";

type ScheduleRange = "today" | "week";

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function scheduleBounds(range: ScheduleRange) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + (range === "today" ? 1 : 7));
  return { from: from.toISOString(), to: to.toISOString() };
}

function scheduleDay(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function scheduleTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function MembersPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [scheduleRange, setScheduleRange] = useState<ScheduleRange>("today");
  const [schedule, setSchedule] = useState<StaffScheduleEntry[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadStaff() {
      try {
        const response = await fetch("/api/members", {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load staff.");
        const data = staffMembersResponseSchema.parse(await response.json());
        setStaff(data.staff);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load staff.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadStaff();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const bounds = scheduleBounds(scheduleRange);

    async function loadSchedule() {
      setScheduleLoading(true);
      try {
        const query = new URLSearchParams(bounds);
        const response = await fetch(`/api/members/schedule?${query}`, {
          credentials: "same-origin",
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Could not load staff schedule.");
        const data = staffScheduleResponseSchema.parse(await response.json());
        setSchedule(data.entries);
        setScheduleError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setScheduleError(cause instanceof Error ? cause.message : "Could not load staff schedule.");
        }
      } finally {
        if (!controller.signal.aborted) setScheduleLoading(false);
      }
    }

    void loadSchedule();
    return () => controller.abort();
  }, [scheduleRange]);

  const scheduleDays = useMemo(() => {
    const groups = new Map<string, StaffScheduleEntry[]>();
    for (const entry of schedule) {
      const key = localDateKey(new Date(entry.departureAt));
      const current = groups.get(key) ?? [];
      current.push(entry);
      groups.set(key, current);
    }
    return [...groups.entries()];
  }, [schedule]);

  async function createStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = createStaffMemberSchema.safeParse({
      displayName,
      username,
      email: email.trim() ? email : null,
      temporaryPassword
    });

    if (!parsed.success) {
      setError("Enter a name, 3–32 character username, optional valid email, and a 12+ character temporary password.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/members", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = body && typeof body === "object" && "error" in body &&
          typeof body.error === "string" ? body.error : "Could not create staff account.";
        throw new Error(message);
      }

      const created = staffMemberSchema.parse(await response.json());
      setStaff((current) => [...current, created].sort((a, b) =>
        a.displayName.localeCompare(b.displayName) || a.username.localeCompare(b.username)
      ));
      setDisplayName("");
      setUsername("");
      setEmail("");
      setTemporaryPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create staff account.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Members</h1>
      <p className="description">Create staff logins and see who is working when.</p>

      <section className="member-schedule-section" aria-label="Staff schedule">
        <div className="member-schedule-head">
          <div>
            <h2>Staff schedule</h2>
            <p>Planned and recorded trip assignments.</p>
          </div>
          <div className="member-schedule-range" aria-label="Schedule range">
            <button type="button" className={scheduleRange === "today" ? "is-active" : ""}
              onClick={() => setScheduleRange("today")}>Today</button>
            <button type="button" className={scheduleRange === "week" ? "is-active" : ""}
              onClick={() => setScheduleRange("week")}>7 days</button>
          </div>
        </div>

        {scheduleError && <p className="auth-error" role="alert">{scheduleError}</p>}
        {scheduleLoading ? (
          <p className="member-schedule-empty">Loading schedule…</p>
        ) : scheduleDays.length === 0 ? (
          <p className="member-schedule-empty">No staff trips scheduled in this window.</p>
        ) : (
          <div className="member-schedule-days">
            {scheduleDays.map(([day, entries]) => (
              <section className="member-schedule-day" key={day}>
                <h3>{scheduleDay(entries[0].departureAt)}</h3>
                <div className="member-schedule-table-wrap">
                  <table className="member-schedule-table">
                    <thead>
                      <tr><th>Time</th><th>Staff</th><th>Route</th><th>Bus</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.tripId}>
                          <td>{scheduleTime(entry.departureAt)}</td>
                          <td><strong>{entry.displayName}</strong></td>
                          <td>{entry.routeName} · {entry.servicePeriod}</td>
                          <td>{entry.busLabel}</td>
                          <td><span className={`member-schedule-status member-schedule-status-${entry.status}`}>{entry.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      <form className="member-form" onSubmit={(event) => void createStaff(event)}>
        <h2>Create staff login</h2>
        <p className="member-hint">They must change the temporary password the first time they sign in.</p>
        <div className="member-form-grid">
          <label>
            Name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} />
          </label>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={32} autoCapitalize="none" autoCorrect="off" />
          </label>
          <label>
            Email <span>(optional)</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoCapitalize="none" autoCorrect="off" />
          </label>
          <label>
            Temporary password
            <input type="password" value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} required minLength={12} autoComplete="new-password" />
          </label>
        </div>
        <button className="auth-button" type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create staff login"}
        </button>
      </form>

      {error && <p className="auth-error" role="alert">{error}</p>}

      <section className="member-list-section">
        <h2>Staff</h2>
        {loading ? (
          <p>Loading staff…</p>
        ) : staff.length === 0 ? (
          <p>No staff accounts yet.</p>
        ) : (
          <ul className="member-list">
            {staff.map((person) => (
              <li key={person.id}>
                <div>
                  <strong>{person.displayName}</strong>
                  <span>@{person.username}{person.email ? ` · ${person.email}` : ""}</span>
                </div>
                <span>{person.suspended ? "Suspended" : person.passwordChangeRequired ? "Password setup required" : "Active"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
