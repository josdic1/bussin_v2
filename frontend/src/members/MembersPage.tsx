import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  createStaffMemberSchema, staffMemberSchema, staffMembersResponseSchema, staffPasswordResetSchema, staffScheduleResponseSchema,
  updateStaffMemberSchema, usernameSuggestionSchema, type StaffMember, type StaffScheduleEntry
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { tidyEmail } from "../ops/contact";
import { useAuth } from "../auth/AuthProvider";
import { hashColor, localDate, plural, time } from "../ops/format";
import { Overlay, useOps } from "../ops/OpsShell";
import { Avatar, ErrorNote, Head, NoMatch, Plus, Search, Tile, type Tone } from "../ops/ui";

type Status = "ACTIVE" | "SETUP REQUIRED" | "SUSPENDED";
type Filter = "ALL" | Status;
type OverlayState = { type: "staff"; id: string } | { type: "add" } | null;

function statusOf(person: StaffMember): Status {
  return person.suspended ? "SUSPENDED" : person.passwordChangeRequired ? "SETUP REQUIRED" : "ACTIVE";
}

/** Admin and Dispatch get a pill; plain counselors don't need one. */
function RolePills({ person }: { person: StaffMember }) {
  return <>{person.roles.filter((role) => role !== "staff").map((role) =>
    <span key={role} className={`role-pill role-${role}`}>{role === "admin" ? "Admin" : "Dispatch"}</span>)}</>;
}

const handle = (person: StaffMember) => person.username ? `@${person.username}` : "Email sign-in";

function StatusPill({ status }: { status: Status }) {
  return <span className={`st st-m-${status.toLowerCase().replace(" ", "-")}`}>{status}</span>;
}

function weekBounds() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 7);
  return { from: from.toISOString(), to: to.toISOString() };
}

function dayHeading(value: string) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(16);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

/** First name + last initial from the server, which knows every username in use. */
function useUsernameSuggestion(name: string, enabled: boolean, apply: (username: string) => void) {
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    if (!enabled || !name.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getJson(`/api/members/username?${new URLSearchParams({ name })}`, usernameSuggestionSchema, controller.signal)
        .then((result) => latest.current(result.username)).catch(() => undefined);
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [name, enabled]);
}

function EditStaff({ person, onSaved, onCancel }: { person: StaffMember; onSaved: (person: StaffMember) => void; onCancel: () => void }) {
  const [displayName, setDisplayName] = useState(person.displayName);
  const [username, setUsername] = useState(person.username ?? "");
  const [email, setEmail] = useState(person.email ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = updateStaffMemberSchema.safeParse({ displayName, username, email: email.trim() ? email : null });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the details."); return; }
    setSaving(true); setError("");
    try {
      onSaved(staffMemberSchema.parse(await send("PUT", `/api/members/${person.id}`, parsed.data, "Could not save.")));
    } catch (cause) { setError(message(cause, "Could not save.")); } finally { setSaving(false); }
  }
  return <form className="mf" onSubmit={(event) => void submit(event)} noValidate>
    <label><b className="lt">Name</b><input value={displayName} maxLength={120} autoComplete="off" onChange={(event) => setDisplayName(event.target.value)} /></label>
    <label><b className="lt">Username</b><input value={username} maxLength={32} autoCapitalize="none" autoCorrect="off" autoComplete="off"
      onChange={(event) => setUsername(event.target.value.toLowerCase())} />
      <small>First name + last initial is easiest to remember, like emilyg.</small></label>
    <label><b className="lt">Email <span>(optional)</span></b><input type="email" value={email} autoCapitalize="none" autoComplete="off"
      onChange={(event) => setEmail(event.target.value)} onBlur={() => setEmail(tidyEmail(email))} /></label>
    <p className="mf-err" role="alert">{error}</p>
    <div className="acts"><button type="button" className="btn" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button></div>
  </form>;
}

function StaffDetail({ person, schedule, onChanged }: {
  person: StaffMember; schedule: StaffScheduleEntry[]; onChanged: (person: StaffMember, note: string) => void;
}) {
  const { member } = useAuth();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState<string | null>(null);
  const isMe = member?.id === person.id;
  const status = statusOf(person);

  async function setSuspended(suspended: boolean) {
    if (suspended && !window.confirm(`Suspend ${person.displayName}? They are signed out everywhere and can't sign in until reactivated.`)) return;
    setBusy(true); setError("");
    try {
      const next = staffMemberSchema.parse(await send("POST", `/api/members/${person.id}/status`, { suspended }, "Could not change status."));
      onChanged(next, suspended ? `${person.displayName} is suspended.` : `${person.displayName} can sign in again.`);
    } catch (cause) { setError(message(cause, "Could not change status.")); } finally { setBusy(false); }
  }
  async function resetPassword() {
    if (!window.confirm(`Give ${person.displayName} a new temporary password? Their current password stops working.`)) return;
    setBusy(true); setError("");
    try {
      const result = staffPasswordResetSchema.parse(await send("POST", `/api/members/${person.id}/reset-password`, undefined, "Could not reset the password."));
      setPassword(result.temporaryPassword);
      onChanged({ ...person, passwordChangeRequired: true }, `New temporary password for ${person.displayName}.`);
    } catch (cause) { setError(message(cause, "Could not reset the password.")); } finally { setBusy(false); }
  }
  const mine = schedule.filter((entry) => entry.memberId === person.id);
  const note = status === "SETUP REQUIRED"
    ? "Has not set a personal password yet. They must change the temporary password at first sign-in."
    : status === "SUSPENDED" ? "This login is suspended and cannot sign in." : "Signed in with a personal password.";
  return <>
    <p className="eyebrow">{person.roles.includes("admin") ? "ADMIN" : person.roles.includes("dispatch") ? "DISPATCH" : "STAFF"}</p>
    <h2 className="d-title"><Avatar name={person.displayName} color={hashColor(person.id)} size={44} />{person.displayName}</h2>
    <div className="d-status"><StatusPill status={status} /><RolePills person={person} /></div>
    {password && <div className="ok-note"><b>New temporary password</b>Give {person.displayName} username <code>{person.username ?? person.email}</code> and
      password <code>{password}</code>. They choose their own at sign-in. This is the only time it is shown.</div>}
    {editing
      ? <EditStaff person={person} onCancel={() => setEditing(false)}
          onSaved={(next) => { setEditing(false); onChanged(next, `${next.displayName} saved.`); }} />
      : <><dl className="d-grid">
      <div><dt>Username</dt><dd>{handle(person)}</dd></div>
      <div><dt>Email</dt><dd>{person.email ?? "—"}</dd></div>
      <div><dt>Status</dt><dd>{status.charAt(0) + status.slice(1).toLowerCase()}</dd></div>
      <div><dt>Password</dt><dd>{person.passwordChangeRequired ? "Temporary" : "Personal"}</dd></div>
    </dl>
    <div className="acts">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
      {!isMe && <button type="button" className="btn" disabled={busy} onClick={() => void resetPassword()}>Reset password</button>}
      {!isMe && (person.suspended
        ? <button type="button" className="btn" disabled={busy} onClick={() => void setSuspended(false)}>Reactivate</button>
        : <button type="button" className="btn" disabled={busy} onClick={() => void setSuspended(true)}>Suspend</button>)}
    </div>
    {error && <p className="mf-err" role="alert">{error}</p>}</>}
    <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{note}</p>
    <div className="d-sec"><h3>Next 7 days</h3><span>{mine.length} {plural(mine.length, "trip", "trips")}</span></div>
    {!mine.length && <p className="muted">No trips assigned.</p>}
    {mine.map((entry) => <div key={entry.tripId} className="d-trip">
      <div><strong>{entry.routeName}</strong><span>{dayHeading(entry.departureAt)} · {time(entry.departureAt)} · {entry.busLabel}</span></div>
      <span className={`ts ts-${entry.status}`}>{entry.status}</span></div>)}
  </>;
}

function AddStaffForm({ taken, onCreated }: {
  taken: (username: string) => boolean; onCreated: (person: StaffMember, password: string) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [touched, setTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Username follows the name (emilyg) until you type your own.
  useUsernameSuggestion(displayName, !touched, setUsername);
  function nameChanged(value: string) {
    setDisplayName(value);
    if (!touched && !value.trim()) setUsername("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createStaffMemberSchema.safeParse({ displayName, username, email: email.trim() ? email : null, temporaryPassword: password });
    if (!parsed.success) {
      setError("Enter a name, 3–32 character username, optional valid email, and a 12+ character temporary password.");
      return;
    }
    if (taken(parsed.data.username)) { setError("That username is already taken."); return; }
    setSaving(true);
    setError("");
    try {
      const created = staffMemberSchema.parse(await send("POST", "/api/members", parsed.data, "Could not create staff login."));
      onCreated(created, password);
      setDisplayName(""); setUsername(""); setTouched(false); setEmail(""); setPassword("");
    } catch (cause) {
      setError(message(cause, "Could not create staff login."));
    } finally { setSaving(false); }
  }

  return <form className="mf" onSubmit={(event) => void submit(event)} noValidate>
    <p className="mf-hint">They must change the temporary password the first time they sign in.</p>
    <label><b className="lt">Name</b><input value={displayName} maxLength={120} autoComplete="off" onChange={(event) => nameChanged(event.target.value)} /></label>
    <label><b className="lt">Username</b><input value={username} maxLength={32} autoCapitalize="none" autoCorrect="off" autoComplete="off"
      onChange={(event) => { setTouched(true); setUsername(event.target.value.toLowerCase()); }} />
      <small>Made from the name: first name + last initial, like emilyg. Never a duplicate.</small></label>
    <label><b className="lt">Email <span>(optional)</span></b><input type="email" value={email} autoCapitalize="none" autoCorrect="off" autoComplete="off"
      onChange={(event) => setEmail(event.target.value)} /></label>
    <label><b className="lt">Temporary password</b><span className="pw">
      <input type="text" value={password} autoComplete="off" onChange={(event) => setPassword(event.target.value)} />
      <button type="button" onClick={() => setPassword(generatePassword())}>Generate</button></span>
      <small>12 characters or more.</small></label>
    <p className="mf-err" role="alert">{error}</p>
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Creating…" : "Create staff login"}</button>
  </form>;
}

export function MembersPage() {
  const { mode, toast } = useOps();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [schedule, setSchedule] = useState<StaffScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"staff" | "schedule">("staff");
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [created, setCreated] = useState<{ name: string; username: string; password: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getJson("/api/members", staffMembersResponseSchema, controller.signal),
      getJson(`/api/members/schedule?${new URLSearchParams(weekBounds())}`, staffScheduleResponseSchema, controller.signal)
    ]).then(([staffData, scheduleData]) => {
      setStaff(staffData.staff);
      setSchedule(scheduleData.entries);
      setError("");
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause, "Could not load staff."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const counts = useMemo(() => ({
    ALL: staff.length,
    ACTIVE: staff.filter((person) => statusOf(person) === "ACTIVE").length,
    "SETUP REQUIRED": staff.filter((person) => statusOf(person) === "SETUP REQUIRED").length,
    SUSPENDED: staff.filter((person) => statusOf(person) === "SUSPENDED").length
  }), [staff]);
  const needle = query.trim().toLowerCase();
  const visible = staff.filter((person) =>
    (!needle || [person.displayName, person.username ?? "", person.email ?? "", ...person.roles].some((value) => value.toLowerCase().includes(needle))) &&
    (filter === "ALL" || statusOf(person) === filter))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || (a.username ?? "").localeCompare(b.username ?? ""));

  const openAdd = () => { setCreated(null); setOverlay({ type: "add" }); };
  const selected = overlay?.type === "staff" ? staff.find((person) => person.id === overlay.id) : null;
  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay.type === "staff"
      ? (selected ? <StaffDetail key={selected.id} person={selected} schedule={schedule}
          onChanged={(next, note) => { setStaff((list) => list.map((p) => (p.id === next.id ? next : p))); toast(note); }} /> : <NoMatch>Not found.</NoMatch>)
      : <><p className="eyebrow">MEMBERS</p><h2 className="dt">Create staff login</h2>
        {created && <div className="ok-note"><b>Created {created.name}</b>Give them username <code>{created.username}</code> and
          the temporary password <code>{created.password}</code>.</div>}
        <AddStaffForm taken={(username) => staff.some((person) => person.username === username)}
          onCreated={(person, password) => {
            setStaff((current) => [...current, person]);
            setCreated({ name: person.displayName, username: person.username ?? "", password });
            toast(`${person.displayName} can now sign in.`);
          }} /></>}
  </Overlay>;
  const status = <><ErrorNote text={error} />{loading && <p className="hint">Loading staff…</p>}</>;
  const open = (id: string) => setOverlay({ type: "staff", id });
  const tiles: [Filter, string, number, string][] = [
    ["ALL", "All logins", counts.ALL, "admin, dispatch and staff"], ["ACTIVE", "Active", counts.ACTIVE, "personal password"],
    ["SETUP REQUIRED", "Setup required", counts["SETUP REQUIRED"], "temporary password"],
    ["SUSPENDED", "Suspended", counts.SUSPENDED, "cannot sign in"]];

  if (mode === "desktop") {
    const days = new Map<string, StaffScheduleEntry[]>();
    for (const entry of schedule) {
      const key = localDate(new Date(entry.departureAt));
      days.set(key, [...(days.get(key) ?? []), entry]);
    }
    return <>
      <Head eyebrow="Staff" title="Members" sub="Everyone who signs in to run the camp: admins, dispatchers and counselors."
        actions={<button type="button" className="btn btn-primary" onClick={openAdd}>Add staff login</button>} />
      {status}
      <div className="tiles">{tiles.map(([key, label, value, sub]) => <Tile key={key} label={label} value={value} sub={sub}
        pressed={tab === "staff" && filter === key} className={tab === "staff" && filter === key ? "on" : ""}
        onClick={() => { setFilter(key); setTab("staff"); }} />)}</div>
      <div className="tabs2" role="tablist">
        {([["staff", "Staff logins"], ["schedule", "Schedule, next 7 days"]] as const).map(([key, label]) =>
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""}
            onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {tab === "staff" ? <>
        <div className="filters" style={{ marginTop: 16 }}><Search label="Search" value={query} onChange={setQuery} placeholder="Name, username or email" /></div>
        <table className="tbl"><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Status</th></tr></thead>
          <tbody>{visible.length ? visible.map((person) => <tr key={person.id} data-ov="" tabIndex={0} onClick={() => open(person.id)}
            onKeyDown={(event) => { if (event.key === "Enter") open(person.id); }}>
            <td><div className="who"><Avatar name={person.displayName} color={hashColor(person.id)} size={36} /><strong>{person.displayName}</strong><RolePills person={person} /></div></td>
            <td className="mono">{handle(person)}</td>
            <td>{person.email ?? <span className="dim">&mdash;</span>}</td>
            <td><StatusPill status={statusOf(person)} /></td></tr>)
            : <tr><td colSpan={4} className="nomatch">{loading ? "Loading…" : "No staff match this view."}</td></tr>}</tbody></table>
      </> : <div style={{ marginTop: 16 }}>
        {!days.size && <NoMatch>{loading ? "Loading…" : "No staff trips scheduled in the next 7 days."}</NoMatch>}
        {[...days.entries()].map(([key, entries]) => <div key={key} style={{ marginBottom: 18 }}>
          <div className="sec-h"><h2>{dayHeading(entries[0].departureAt)}</h2><span>{entries.length} {plural(entries.length, "trip", "trips")}</span></div>
          <table className="tbl"><thead><tr><th>Time</th><th>Staff</th><th>Route</th><th>Bus</th><th>Status</th></tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.tripId}>
              <td>{time(entry.departureAt)}</td><td><strong>{entry.displayName}</strong></td>
              <td>{entry.routeName}<small>{entry.servicePeriod}</small></td><td>{entry.busLabel}</td>
              <td><span className={`st st-t-${entry.status}`}>{entry.status.toUpperCase()}</span></td></tr>)}</tbody></table>
        </div>)}
      </div>}
      {overlayView}
    </>;
  }

  const groups: [Status, string, string][] = [["SETUP REQUIRED", "Setup required", "warn"], ["ACTIVE", "Active", ""], ["SUSPENDED", "Suspended", "bad"]];
  return <>
    <Head eyebrow="Staff" title="Members" sub={`${counts.ALL} logins`} actions={<Plus label="Add staff login" onClick={openAdd} />} />
    {status}
    <Search value={query} onChange={setQuery} placeholder="Search staff" />
    {groups.map(([key, label, cls]) => {
      const list = visible.filter((person) => statusOf(person) === key);
      return list.length > 0 && <div key={key}>
        <h2 className={`sh2 ${cls === "warn" ? "warn" : ""}`} style={{ display: "flex", justifyContent: "space-between" }}><span>{label}</span><span>{list.length}</span></h2>
        <div className="surface sl">{list.map((person) => <button key={person.id} type="button" className="srow" style={{ alignItems: "center" }} onClick={() => open(person.id)}>
          <Avatar name={person.displayName} color={hashColor(person.id)} /><span><b>{person.displayName} <RolePills person={person} /></b><small>{handle(person)}</small></span><span className="go">&rsaquo;</span></button>)}</div>
      </div>;
    })}
    {overlayView}
  </>;
}
