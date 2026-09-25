import { useEffect, useState, type FormEvent } from "react";
import {
  createStaffMemberSchema,
  staffMemberSchema,
  staffMembersResponseSchema,
  type StaffMember
} from "@bussin/shared";

export function MembersPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");

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
      <p className="description">Create staff logins for people who will run bus trips.</p>

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
