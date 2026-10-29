import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import {
  createStaffMemberSchema, driverInputSchema, staffMemberSchema, staffMembersResponseSchema, staffPasswordResetSchema,
  staffScheduleResponseSchema, teamDriverSchema, teamDriversResponseSchema, updateStaffMemberSchema, usernameSuggestionSchema,
  type StaffMember, type StaffScheduleEntry, type TeamDriver
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { tidyEmail, tidyPhone } from "../ops/contact";
import { useAuth } from "../auth/AuthProvider";
import { hashColor, localDate, plural, time } from "../ops/format";
import { Overlay, useOps } from "../ops/OpsShell";
import { Avatar, ErrorNote, Head, NoMatch, Plus, Search } from "../ops/ui";

// Team: everyone who works the buses, in one place.
//   Counselors  sign in on their phone and do Ride Check. Lead or counselor is picked per trip.
//   Drivers     never sign in. A name and a phone that Dispatch puts on each trip.
//   Office      admins and dispatchers.

type Status = "ACTIVE" | "SETUP REQUIRED" | "SUSPENDED";
type Tab = "counselors" | "drivers" | "office" | "schedule";
type OverlayState = { type: "staff"; id: string } | { type: "driver"; id: string } | { type: "add"; kind: "counselor" | "driver" } | null;

const isOffice = (person: StaffMember) => person.roles.includes("admin") || person.roles.includes("dispatch");

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
    <p className="eyebrow">{person.roles.includes("admin") ? "ADMIN" : person.roles.includes("dispatch") ? "DISPATCH" : "COUNSELOR"}</p>
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
      const created = staffMemberSchema.parse(await send("POST", "/api/members", parsed.data, "Could not create counselor login."));
      onCreated(created, password);
      setDisplayName(""); setUsername(""); setTouched(false); setEmail(""); setPassword("");
    } catch (cause) {
      setError(message(cause, "Could not create counselor login."));
    } finally { setSaving(false); }
  }

  return <form className="mf" onSubmit={(event) => void submit(event)} noValidate>
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
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Creating…" : "Create counselor login"}</button>
  </form>;
}

// ---------- Drivers ----------

function DriverForm({ driver, onSaved, onCancel }: {
  driver?: TeamDriver; onSaved: (driver: TeamDriver) => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(driver?.name ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = driverInputSchema.safeParse({ name, phone });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the details."); return; }
    setSaving(true); setError("");
    try {
      const body = driver
        ? await send("PUT", `/api/drivers/${driver.id}`, { name, phone }, "Could not save the driver.")
        : await send("POST", "/api/drivers", { name, phone }, "Could not add the driver.");
      onSaved(teamDriverSchema.parse(body));
      if (!driver) { setName(""); setPhone(""); }
    } catch (cause) { setError(message(cause, "Could not save the driver.")); } finally { setSaving(false); }
  }
  return <form className="mf" onSubmit={(event) => void submit(event)} noValidate>
    <label><b className="lt">Name</b><input value={name} maxLength={120} autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
    <label><b className="lt">Phone <span>(optional)</span></b><input type="tel" value={phone} maxLength={40} autoComplete="off"
      onChange={(event) => setPhone(event.target.value)} onBlur={() => setPhone(tidyPhone(phone))} />
      <small>Dispatch sees it on every trip this driver is on, so they can call.</small></label>
    <p className="mf-err" role="alert">{error}</p>
    <div className="acts">{onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : driver ? "Save" : "Add driver"}</button></div>
  </form>;
}

function DriverDetail({ driver, onChanged }: { driver: TeamDriver; onChanged: (driver: TeamDriver, note: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function setActive(active: boolean) {
    if (!active && !window.confirm(`Retire ${driver.name}? They stay on past trips but can't be put on new ones.`)) return;
    setBusy(true); setError("");
    try {
      const next = teamDriverSchema.parse(await send("POST", `/api/drivers/${driver.id}/status`, { active }, "Could not change status."));
      onChanged(next, active ? `${driver.name} is back on the roster.` : `${driver.name} is retired.`);
    } catch (cause) { setError(message(cause, "Could not change status.")); } finally { setBusy(false); }
  }
  return <>
    <p className="eyebrow">DRIVER · NO LOGIN</p>
    <h2 className="d-title"><Avatar name={driver.name} color={hashColor(driver.id)} size={44} />{driver.name}</h2>
    <div className="d-status"><span className={`st ${driver.active ? "st-m-active" : "st-m-suspended"}`}>{driver.active ? "ACTIVE" : "RETIRED"}</span></div>
    {editing
      ? <DriverForm driver={driver} onCancel={() => setEditing(false)} onSaved={(next) => { setEditing(false); onChanged(next, `${next.name} saved.`); }} />
      : <><dl className="d-grid">
        <div><dt>Phone</dt><dd>{driver.phone ?? "—"}</dd></div>
        <div><dt>Status</dt><dd>{driver.active ? "Active" : "Retired"}</dd></div>
      </dl>
      <div className="acts">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="btn" disabled={busy} onClick={() => void setActive(!driver.active)}>{driver.active ? "Retire" : "Bring back"}</button>
      </div>
      {error && <p className="mf-err" role="alert">{error}</p>}</>}
    <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>Drivers don't sign in. Dispatch picks the driver when planning each trip.</p>
    <div className="d-sec"><h3>Next 7 days</h3><span>{driver.upcoming.length} {plural(driver.upcoming.length, "trip", "trips")}</span></div>
    {!driver.upcoming.length && <p className="muted">No trips assigned.</p>}
    {driver.upcoming.map((entry) => <div key={entry.tripId} className="d-trip">
      <div><strong>{entry.routeName}</strong><span>{dayHeading(entry.departureAt)} · {time(entry.departureAt)} · {entry.busLabel}</span></div></div>)}
  </>;
}

// ---------- Add someone: counselor or driver first, then only the fields that apply ----------

function AddPerson({ kind, setKind, staff, onCounselor, onDriver }: {
  kind: "counselor" | "driver"; setKind: (kind: "counselor" | "driver") => void; staff: StaffMember[];
  onCounselor: (person: StaffMember, password: string) => void; onDriver: (driver: TeamDriver) => void;
}) {
  const [created, setCreated] = useState<{ name: string; username: string; password: string } | null>(null);
  const [addedDriver, setAddedDriver] = useState("");
  return <>
    <p className="eyebrow">TEAM</p><h2 className="dt">Add someone</h2>
    <div className="seg team-kind" role="group" aria-label="Who are you adding?">
      {(["counselor", "driver"] as const).map((item) => <button key={item} type="button" className={kind === item ? "on" : ""}
        aria-pressed={kind === item} onClick={() => { setKind(item); setCreated(null); setAddedDriver(""); }}>
        {item === "counselor" ? "Counselor" : "Driver"}</button>)}
    </div>
    {kind === "counselor" ? <>
      <p className="muted team-note">Rides the bus and does Ride Check on their phone, so they get a login. Lead or counselor is picked on each trip.
        They change the temporary password the first time they sign in.</p>
      {created && <div className="ok-note"><b>Created {created.name}</b>Give them username <code>{created.username}</code> and
        the temporary password <code>{created.password}</code>.</div>}
      <AddStaffForm taken={(username) => staff.some((person) => person.username === username)}
        onCreated={(person, password) => { setCreated({ name: person.displayName, username: person.username ?? "", password }); onCounselor(person, password); }} />
    </> : <>
      <p className="muted team-note">Drives the bus. No login: just a name and a phone that Dispatch puts on each trip.</p>
      {addedDriver && <div className="ok-note"><b>Added {addedDriver}</b>Pick them as the driver when you plan a trip.</div>}
      <DriverForm onSaved={(driver) => { setAddedDriver(driver.name); onDriver(driver); }} />
    </>}
  </>;
}

export function TeamPage() {
  const { mode, toast } = useOps();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [drivers, setDrivers] = useState<TeamDriver[]>([]);
  const [schedule, setSchedule] = useState<StaffScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("counselors");
  const [overlay, setOverlay] = useState<OverlayState>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getJson("/api/members", staffMembersResponseSchema, controller.signal),
      getJson("/api/drivers", teamDriversResponseSchema, controller.signal),
      getJson(`/api/members/schedule?${new URLSearchParams(weekBounds())}`, staffScheduleResponseSchema, controller.signal)
    ]).then(([staffData, driverData, scheduleData]) => {
      setStaff(staffData.staff);
      setDrivers(driverData.drivers);
      setSchedule(scheduleData.entries);
      setError("");
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(message(cause, "Could not load the team."));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const needle = query.trim().toLowerCase();
  const byName = (a: StaffMember, b: StaffMember) => a.displayName.localeCompare(b.displayName) || (a.username ?? "").localeCompare(b.username ?? "");
  const matches = (person: StaffMember) => !needle ||
    [person.displayName, person.username ?? "", person.email ?? ""].some((value) => value.toLowerCase().includes(needle));
  const counselors = staff.filter((person) => !isOffice(person)).sort(byName);
  const office = staff.filter(isOffice).sort(byName);
  const shownDrivers = drivers.filter((driver) => !needle || [driver.name, driver.phone ?? ""].some((value) => value.toLowerCase().includes(needle)));
  const logins = (tab === "office" ? office : counselors).filter(matches);

  const openAdd = (kind: "counselor" | "driver" = tab === "drivers" ? "driver" : "counselor") => setOverlay({ type: "add", kind });
  const selectedStaff = overlay?.type === "staff" ? staff.find((person) => person.id === overlay.id) : null;
  const selectedDriver = overlay?.type === "driver" ? drivers.find((driver) => driver.id === overlay.id) : null;
  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay.type === "staff"
      ? (selectedStaff ? <StaffDetail key={selectedStaff.id} person={selectedStaff} schedule={schedule}
          onChanged={(next, note) => { setStaff((list) => list.map((p) => (p.id === next.id ? next : p))); toast(note); }} /> : <NoMatch>Not found.</NoMatch>)
      : overlay.type === "driver"
        ? (selectedDriver ? <DriverDetail key={selectedDriver.id} driver={selectedDriver}
            onChanged={(next, note) => { setDrivers((list) => list.map((d) => (d.id === next.id ? next : d))); toast(note); }} /> : <NoMatch>Not found.</NoMatch>)
        : <AddPerson kind={overlay.kind} setKind={(kind) => setOverlay({ type: "add", kind })} staff={staff}
            onCounselor={(person) => { setStaff((list) => [...list, person]); setTab("counselors"); toast(`${person.displayName} can now sign in.`); }}
            onDriver={(driver) => { setDrivers((list) => [...list, driver]); setTab("drivers"); toast(`${driver.name} added.`); }} />}
  </Overlay>;

  const tabs: [Tab, string, number | null][] = [
    ["counselors", "Counselors", counselors.length], ["drivers", "Drivers", drivers.filter((d) => d.active).length],
    ["office", "Office", office.length], ["schedule", "Schedule", null]];
  const tabBar = <div className="tabs2 team-tabs" role="tablist">{tabs.map(([key, label, count]) =>
    <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""}
      onClick={() => setTab(key)}>{label}{count !== null && <i>{count}</i>}</button>)}</div>;
  const blurb: Record<Tab, string> = {
    counselors: "Sign in on their phone and do Ride Check. Lead or counselor is picked on each trip.",
    drivers: "Drive the bus. No login: a name and a phone on each trip.",
    office: "Admins and dispatchers.",
    schedule: "Who is on which trip in the next 7 days."
  };
  const desktop = mode === "desktop";
  const head = <Head eyebrow="People" title="Team" sub="Everyone who works the buses."
    actions={desktop ? <button type="button" className="btn btn-primary" onClick={() => openAdd()}>Add someone</button>
      : <Plus label="Add someone" onClick={() => openAdd()} />} />;
  const status = <><ErrorNote text={error} />{loading && <p className="hint">Loading the team…</p>}</>;
  const open = (id: string) => setOverlay({ type: "staff", id });
  const openDriver = (id: string) => setOverlay({ type: "driver", id });
  const nextTrip = (driver: TeamDriver) => driver.upcoming[0]
    ? `${dayHeading(driver.upcoming[0].departureAt)} · ${time(driver.upcoming[0].departureAt)} · ${driver.upcoming[0].busLabel}` : null;

  let body: ReactElement;
  if (tab === "schedule") {
    const days = new Map<string, StaffScheduleEntry[]>();
    for (const entry of schedule) {
      const key = localDate(new Date(entry.departureAt));
      days.set(key, [...(days.get(key) ?? []), entry]);
    }
    body = <div>
      {!days.size && <NoMatch>{loading ? "Loading…" : "No trips with counselors in the next 7 days."}</NoMatch>}
      {[...days.entries()].map(([key, entries]) => <div key={key} style={{ marginBottom: 18 }}>
        <div className="sec-h"><h2>{dayHeading(entries[0].departureAt)}</h2><span>{entries.length} {plural(entries.length, "trip", "trips")}</span></div>
        <table className="tbl"><thead><tr><th>Time</th><th>Counselor</th><th>Route</th><th>Bus</th><th>Status</th></tr></thead>
          <tbody>{entries.map((entry) => <tr key={`${entry.tripId}-${entry.memberId}`}>
            <td>{time(entry.departureAt)}</td><td><strong>{entry.displayName}</strong></td>
            <td>{entry.routeName}<small>{entry.servicePeriod}</small></td><td>{entry.busLabel}</td>
            <td><span className={`st st-t-${entry.status}`}>{entry.status.toUpperCase()}</span></td></tr>)}</tbody></table>
      </div>)}
    </div>;
  } else if (tab === "drivers") {
    body = desktop
      ? <table className="tbl"><thead><tr><th>Name</th><th>Phone</th><th>Next trip</th><th>Status</th></tr></thead>
        <tbody>{shownDrivers.length ? shownDrivers.map((driver) => <tr key={driver.id} data-ov="" tabIndex={0} onClick={() => openDriver(driver.id)}
          onKeyDown={(event) => { if (event.key === "Enter") openDriver(driver.id); }}>
          <td><div className="who"><Avatar name={driver.name} color={hashColor(driver.id)} size={36} /><strong>{driver.name}</strong></div></td>
          <td>{driver.phone ?? <span className="dim">&mdash;</span>}</td>
          <td>{nextTrip(driver) ?? <span className="dim">None</span>}</td>
          <td><span className={`st ${driver.active ? "st-m-active" : "st-m-suspended"}`}>{driver.active ? "ACTIVE" : "RETIRED"}</span></td></tr>)
          : <tr><td colSpan={4} className="nomatch">{loading ? "Loading…" : needle ? "No driver matches." : "No drivers yet. Add someone, then pick Driver."}</td></tr>}</tbody></table>
      : <div className="surface sl">{shownDrivers.length ? shownDrivers.map((driver) => <button key={driver.id} type="button" className="srow"
          style={{ alignItems: "center" }} onClick={() => openDriver(driver.id)}>
          <Avatar name={driver.name} color={hashColor(driver.id)} /><span><b>{driver.name}{!driver.active && " (retired)"}</b>
            <small>{driver.phone ?? "No phone"}</small></span><span className="go">&rsaquo;</span></button>)
        : <NoMatch>{loading ? "Loading…" : "No drivers yet."}</NoMatch>}</div>;
  } else {
    body = desktop
      ? <table className="tbl"><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Status</th></tr></thead>
        <tbody>{logins.length ? logins.map((person) => <tr key={person.id} data-ov="" tabIndex={0} onClick={() => open(person.id)}
          onKeyDown={(event) => { if (event.key === "Enter") open(person.id); }}>
          <td><div className="who"><Avatar name={person.displayName} color={hashColor(person.id)} size={36} /><strong>{person.displayName}</strong><RolePills person={person} /></div></td>
          <td className="mono">{handle(person)}</td>
          <td>{person.email ?? <span className="dim">&mdash;</span>}</td>
          <td><StatusPill status={statusOf(person)} /></td></tr>)
          : <tr><td colSpan={4} className="nomatch">{loading ? "Loading…" : needle ? "No one matches." : "No one here yet."}</td></tr>}</tbody></table>
      : <div className="surface sl">{logins.length ? logins.map((person) => <button key={person.id} type="button" className="srow"
          style={{ alignItems: "center" }} onClick={() => open(person.id)}>
          <Avatar name={person.displayName} color={hashColor(person.id)} /><span><b>{person.displayName} <RolePills person={person} /></b>
            <small>{handle(person)}{statusOf(person) !== "ACTIVE" ? ` · ${statusOf(person).toLowerCase()}` : ""}</small></span>
          <span className="go">&rsaquo;</span></button>)
        : <NoMatch>{loading ? "Loading…" : "No one here yet."}</NoMatch>}</div>;
  }

  return <>
    {head}
    {status}
    {tabBar}
    <p className="muted team-blurb">{blurb[tab]}</p>
    {tab !== "schedule" && <div className="filters"><Search label="Search" value={query} onChange={setQuery}
      placeholder={tab === "drivers" ? "Name or phone" : "Name, username or email"} /></div>}
    {body}
    {overlayView}
  </>;
}
