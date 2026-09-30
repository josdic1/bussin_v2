import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import {
  guardianInputSchema, guardiansResponseSchema, riderInputSchema, rosterResponseSchema, routesResponseSchema,
  type Guardian, type Rider, type Route
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { PALETTE, plural } from "../ops/format";
import { Overlay, useOps } from "../ops/OpsShell";
import { Avatar, ErrorNote, Head, NoMatch, Plus, Search, Seg, Tile } from "../ops/ui";

type AccountStatus = Guardian["accountStatus"];
type OverlayState =
  | { type: "rider"; id: string } | { type: "guardian"; id: string }
  | { type: "riderForm"; id: string | null } | { type: "guardianForm"; id: string | null }
  | { type: "links"; id: string } | null;

const RIDER_LABEL: Record<AccountStatus, string> = { active: "ACCOUNT ACTIVE", pending: "SETUP NEEDED", none: "NO ACCOUNT" };
const GUARDIAN_LABEL: Record<AccountStatus, string> = { active: "ACTIVE", pending: "SETUP NEEDED", none: "NO ACCOUNT" };

function riderStatus(rider: Rider): AccountStatus {
  if (rider.guardians.some((guardian) => guardian.accountStatus === "pending")) return "pending";
  if (rider.guardians.some((guardian) => guardian.accountStatus === "active")) return "active";
  return "none";
}

/** No AM and no PM stop means no bus comes for this child. */
function hasNoRoute(rider: Rider) { return !rider.am && !rider.pm; }
function needsAttention(rider: Rider) { return hasNoRoute(rider) || riderStatus(rider) === "pending"; }

function CoverageTag({ rider }: { rider: Rider }) {
  if (hasNoRoute(rider)) return <span className="st st-cov-none">NO ROUTE</span>;
  if (!rider.pm) return <span className="st st-cov-one">AM ONLY</span>;
  if (!rider.am) return <span className="st st-cov-one">PM ONLY</span>;
  return null;
}

const MAX_GUARDIANS = 10;

/**
 * Type to find a guardian by name, email or phone. Picked guardians show as
 * removable tags. If nobody matches, a new guardian can be created right here
 * and is added to the selection straight away.
 */
function GuardianPicker({ guardians, riders, value, onChange, lastName }: {
  guardians: Guardian[]; riders: Rider[]; value: string[]; onChange: (ids: string[]) => void; lastName: string;
}) {
  const [query, setQuery] = useState("");
  const [created, setCreated] = useState<Guardian[]>([]);
  const [draft, setDraft] = useState<{ name: string; email: string; phone: string } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const all = [...guardians, ...created.filter((item) => !guardians.some((guardian) => guardian.id === item.id))];
  const byId = (id: string) => all.find((guardian) => guardian.id === id);
  const full = value.length >= MAX_GUARDIANS;

  const kids = (id: string) => riders.filter((rider) => rider.guardians.some((guardian) => guardian.id === id))
    .map((rider) => rider.givenName);
  const detail = (guardian: Guardian) => {
    const parts = [guardian.email ?? "No email", guardian.phone ?? ""].filter(Boolean);
    const children = kids(guardian.id);
    if (children.length) parts.push(`Parent of ${children.join(", ")}`);
    return parts.join(" · ");
  };

  const needle = query.trim().toLowerCase();
  const family = lastName.trim().toLowerCase();
  const open = all.filter((guardian) => !value.includes(guardian.id));
  const matches = needle
    ? open.filter((guardian) => [guardian.name, guardian.email ?? "", guardian.phone ?? ""].join(" ").toLowerCase().includes(needle))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)) || a.name.localeCompare(b.name))
      .slice(0, 8)
    : family ? open.filter((guardian) => guardian.name.toLowerCase().split(/\s+/).at(-1) === family).slice(0, 5) : [];

  const add = (id: string) => { if (!full) { onChange([...value, id]); setQuery(""); } };
  const remove = (id: string) => onChange(value.filter((item) => item !== id));
  const startNew = () => { setDraft({ name: query.trim(), email: "", phone: "" }); setError(""); };

  async function create() {
    if (!draft) return;
    const parsed = guardianInputSchema.safeParse({ name: draft.name, email: draft.email.trim() || null, phone: draft.phone.trim() || null });
    if (!parsed.success) { setError("Enter a name. Email and phone must be valid if filled in."); return; }
    setSaving(true);
    setError("");
    try {
      const body = await send("POST", "/api/families/guardians", { ...parsed.data, riderId: null }, "Could not add guardian.");
      const id = body && typeof body === "object" && "id" in body && typeof body.id === "string" ? body.id : "";
      if (!id) throw new Error("Server did not return the new guardian.");
      setCreated((list) => [...list, { id, name: parsed.data.name, email: parsed.data.email, phone: parsed.data.phone,
        accountStatus: "none", lastSignedIn: null, importDataset: null }]);
      onChange([...value, id]);
      setDraft(null);
      setQuery("");
    } catch (cause) {
      setError(message(cause, "Could not add guardian."));
    } finally { setSaving(false); }
  }

  // Enter inside the picker must never submit the rider form.
  const keep = (event: KeyboardEvent, run?: () => void) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    run?.();
  };

  return <div className="gpick">
    <b className="lt">Guardians <span>({value.length} of {MAX_GUARDIANS})</span></b>
    {value.length > 0 && <div className="gchips">{value.map((id) => {
      const guardian = byId(id);
      return <span key={id} className="gchip">{guardian?.name ?? "Guardian"}
        <button type="button" aria-label={`Remove ${guardian?.name ?? "guardian"}`} onClick={() => remove(id)}>&times;</button></span>;
    })}</div>}
    {!draft && <>
      <input type="search" value={query} disabled={full} autoComplete="off"
        placeholder={full ? "Maximum of 10 guardians" : "Search guardians by name, email or phone"}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => keep(event, () => { if (matches[0]) add(matches[0].id); else if (needle) startNew(); })} />
      {!full && (matches.length > 0 || needle) && <div className="gres">
        {!needle && <span className="gres-h">Same last name</span>}
        {matches.map((guardian) => <button key={guardian.id} type="button" onClick={() => add(guardian.id)}>
          <strong>{guardian.name}</strong><small>{detail(guardian)}</small></button>)}
        {needle && !matches.length && <span className="gres-h">No guardian matches &ldquo;{query.trim()}&rdquo;</span>}
        {needle && <button type="button" className="gnew-btn" onClick={startNew}>+ New guardian &ldquo;{query.trim()}&rdquo;</button>}
      </div>}
      {!needle && !full && <button type="button" className="linkish" onClick={startNew}>+ New guardian</button>}
    </>}
    {draft && <div className="gnew">
      <span className="gres-h">New guardian</span>
      <label><b className="lt">Name</b><input value={draft.name} maxLength={120} autoComplete="off" autoFocus
        onChange={(event) => setDraft({ ...draft, name: event.target.value })} onKeyDown={(event) => keep(event, () => void create())} /></label>
      <div className="rf2">
        <label><b className="lt">Email <span>(needed to log in)</span></b><input type="email" value={draft.email} autoCapitalize="none" autoComplete="off"
          onChange={(event) => setDraft({ ...draft, email: event.target.value })} onKeyDown={(event) => keep(event, () => void create())} /></label>
        <label><b className="lt">Phone <span>(optional)</span></b><input type="tel" value={draft.phone} autoComplete="off"
          onChange={(event) => setDraft({ ...draft, phone: event.target.value })} onKeyDown={(event) => keep(event, () => void create())} /></label>
      </div>
      {error && <p className="rf-err" role="alert">{error}</p>}
      <div className="acts">
        <button type="button" className="btn sm btn-primary" disabled={saving} onClick={() => void create()}>{saving ? "Adding…" : "Add and link"}</button>
        <button type="button" className="btn sm" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>}
  </div>;
}

function Pill({ status, guardian }: { status: AccountStatus; guardian?: boolean }) {
  return <span className={`st st-r-${status}`}>{(guardian ? GUARDIAN_LABEL : RIDER_LABEL)[status]}</span>;
}

function signedIn(value: string | null) {
  if (!value) return "Never";
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
}

type GuardianAction = "activate" | "reset-password" | "deactivate";

function actionsFor(guardian: Guardian): { key: GuardianAction; label: string; primary?: boolean; disabled?: string }[] {
  if (guardian.accountStatus === "none") return [{ key: "activate", label: "Activate account", primary: true, disabled: guardian.email ? undefined : "Add an email with Edit to activate" }];
  if (guardian.accountStatus === "pending") return [{ key: "activate", label: "Reactivate account", primary: true }];
  return [{ key: "reset-password", label: "Reset password" }, { key: "deactivate", label: "Deactivate" }];
}

type Draft = { givenName: string; familyName: string; guardianIds: string[]; amRoute: string; amStop: string; pmRoute: string; pmStop: string };

function RiderForm({ rider, guardians, riders, routes, onSaved }: {
  rider: Rider | null; guardians: Guardian[]; riders: Rider[]; routes: Route[]; onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => rider ? {
    givenName: rider.givenName, familyName: rider.familyName, guardianIds: rider.guardians.map((guardian) => guardian.id),
    amRoute: rider.am?.routeId ?? "", amStop: rider.am?.stopId ?? "", pmRoute: rider.pm?.routeId ?? "", pmStop: rider.pm?.stopId ?? ""
  } : { givenName: "", familyName: "", guardianIds: [], amRoute: "", amStop: "", pmRoute: "", pmStop: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const change = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((draft.amRoute && !draft.amStop) || (draft.pmRoute && !draft.pmStop)) { setError("Choose a stop for each selected route."); return; }
    const input = riderInputSchema.safeParse({
      givenName: draft.givenName, familyName: draft.familyName,
      am: draft.amRoute ? { routeId: draft.amRoute, stopId: draft.amStop } : null,
      pm: draft.pmRoute ? { routeId: draft.pmRoute, stopId: draft.pmStop } : null,
      guardianIds: draft.guardianIds
    });
    if (!input.success) { setError(draft.guardianIds.length ? "Enter the rider's name and valid stops." : "Add at least one guardian: search for one, or use + New guardian."); return; }
    setSaving(true);
    setError("");
    try {
      const saved = await send(rider ? "PUT" : "POST", rider ? `/api/families/riders/${rider.id}` : "/api/families/riders", input.data, "Could not save rider.");
      const id = saved && typeof saved === "object" && "id" in saved && typeof saved.id === "string" ? saved.id : rider?.id ?? "";
      onSaved(id);
    } catch (cause) {
      setError(message(cause, "Could not save rider."));
    } finally { setSaving(false); }
  }

  const assignment = (period: "AM" | "PM") => {
    const routeKey = period === "AM" ? "amRoute" : "pmRoute";
    const stopKey = period === "AM" ? "amStop" : "pmStop";
    const chosen = routes.find((route) => route.id === draft[routeKey]);
    return <div className="rf2">
      <label><b className="lt">{period} route</b><select value={draft[routeKey]} onChange={(event) => change({ [routeKey]: event.target.value, [stopKey]: "" })}>
        <option value="">No {period} assignment</option>
        {routes.filter((route) => route.servicePeriod === period && (route.active || route.id === draft[routeKey])).map((route) =>
          <option key={route.id} value={route.id}>{route.name}{route.active ? "" : " (inactive)"}</option>)}
      </select></label>
      <label><b className="lt">{period} stop</b><select value={draft[stopKey]} disabled={!chosen} onChange={(event) => change({ [stopKey]: event.target.value })}>
        <option value="">Choose a stop</option>
        {chosen?.stops.map((stop) => <option key={stop.id} value={stop.id}>{stop.position}. {stop.label}</option>)}
      </select></label>
    </div>;
  };

  return <form className="rf" onSubmit={(event) => void submit(event)} noValidate>
    <div className="rf2">
      <label><b className="lt">Child&rsquo;s first name</b><input value={draft.givenName} maxLength={80} autoComplete="off" onChange={(event) => change({ givenName: event.target.value })} /></label>
      <label><b className="lt">Child&rsquo;s last name</b><input value={draft.familyName} maxLength={80} autoComplete="off" onChange={(event) => change({ familyName: event.target.value })} /></label>
    </div>
    <GuardianPicker guardians={guardians} riders={riders} value={draft.guardianIds} lastName={draft.familyName}
      onChange={(guardianIds) => change({ guardianIds })} />
    {assignment("AM")}
    {assignment("PM")}
    {!draft.amRoute && !draft.pmRoute && <p className="cov-hint">No route yet. No bus will pick this child up until one is chosen.</p>}
    <p className="rf-err" role="alert">{error}</p>
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save rider"}</button>
  </form>;
}

function GuardianForm({ guardian, riders, onSaved }: { guardian: Guardian | null; riders: Rider[]; onSaved: () => void }) {
  const [name, setName] = useState(guardian?.name ?? "");
  const [email, setEmail] = useState(guardian?.email ?? "");
  const [phone, setPhone] = useState(guardian?.phone ?? "");
  const [riderId, setRiderId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = guardianInputSchema.safeParse({ name, email: email.trim() || null, phone: phone.trim() || null });
    if (!parsed.success) { setError("Enter a guardian name, or correct the optional email and phone."); return; }
    setSaving(true);
    setError("");
    try {
      await send(guardian ? "PUT" : "POST", guardian ? `/api/families/guardians/${guardian.id}` : "/api/families/guardians",
        guardian ? parsed.data : { ...parsed.data, riderId: riderId || null }, "Could not save guardian.");
      onSaved();
    } catch (cause) {
      setError(message(cause, "Could not save guardian."));
    } finally { setSaving(false); }
  }

  return <form className="rf" onSubmit={(event) => void submit(event)} noValidate>
    <p className="rf-hint">Add an email to give this guardian a family login. No email means contact only, no login.{guardian?.importDataset ? " Imported contact edits may be replaced by a later import." : ""}</p>
    <label><b className="lt">Guardian name</b><input value={name} maxLength={120} autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
    <div className="rf2">
      <label><b className="lt">Email <span>(needed to log in)</span></b><input type="email" value={email} autoCapitalize="none" autoComplete="off" onChange={(event) => setEmail(event.target.value)} /></label>
      <label><b className="lt">Phone <span>(optional)</span></b><input type="tel" value={phone} autoComplete="off" onChange={(event) => setPhone(event.target.value)} /></label>
    </div>
    {!guardian && <label><b className="lt">Link to rider <span>(optional)</span></b><select value={riderId} onChange={(event) => setRiderId(event.target.value)}>
      <option value="">No rider yet</option>
      {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.givenName} {rider.familyName}</option>)}
    </select></label>}
    <p className="rf-err" role="alert">{error}</p>
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : guardian ? "Save guardian" : "Add guardian"}</button>
  </form>;
}

function LinksForm({ rider, guardians, riders, onSaved }: { rider: Rider; guardians: Guardian[]; riders: Rider[]; onSaved: () => void }) {
  const [ids, setIds] = useState(rider.guardians.map((guardian) => guardian.id));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await send("PUT", `/api/families/riders/${rider.id}/guardians`, { guardianIds: ids }, "Could not update guardian links.");
      onSaved();
    } catch (cause) { setError(message(cause, "Could not update guardian links.")); } finally { setSaving(false); }
  }
  return <form className="rf" onSubmit={(event) => void submit(event)}>
    <GuardianPicker guardians={guardians} riders={riders} value={ids} lastName={rider.familyName} onChange={setIds} />
    <p className="rf-hint">Imported links come from the roster file and cannot be removed here. Links you add here survive reimport.</p>
    <p className="rf-err" role="alert">{error}</p>
    <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save guardians"}</button>
  </form>;
}

export function FamiliesPage() {
  const { mode, toast } = useOps();
  const [riders, setRiders] = useState<Rider[]>([]);
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"riders" | "guardians">("riders");
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [searchParams] = useSearchParams();
  const [attention, setAttention] = useState(() => searchParams.get("attention") === "1");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [busyGuardian, setBusyGuardian] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getJson("/api/families/roster", rosterResponseSchema, controller.signal),
      getJson("/api/families/guardians", guardiansResponseSchema, controller.signal),
      getJson("/api/routes", routesResponseSchema, controller.signal)
    ]).then(([roster, contacts, routeData]) => {
      setRiders(roster.riders);
      setGuardians(contacts.guardians);
      setRoutes(routeData.routes);
      setError("");
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load the roster.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const refresh = () => setRevision((value) => value + 1);

  const families = useMemo(() => [...new Set(routes.map((route) => route.routeFamilyName))].sort(), [routes]);
  const familyOf = (routeId: string, routeName: string) =>
    routes.find((route) => route.id === routeId)?.routeFamilyName ?? routeName.replace(/\s*(AM|PM)$/i, "");
  const riderColor = (rider: Rider) => {
    const assignment = rider.am ?? rider.pm;
    if (!assignment) return "#a9b3ab";
    const index = families.indexOf(familyOf(assignment.routeId, assignment.routeName));
    return index < 0 ? "#a9b3ab" : PALETTE[index % PALETTE.length];
  };
  const kidsOf = (guardianId: string) => riders.filter((rider) => rider.guardians.some((guardian) => guardian.id === guardianId));

  const needle = query.trim().toLowerCase();
  const visible = riders.filter((rider) => {
    const text = [rider.givenName, rider.familyName, ...rider.guardians.map((guardian) => `${guardian.name} ${guardian.email ?? ""}`),
      rider.am?.routeName ?? "", rider.pm?.routeName ?? ""].join(" ").toLowerCase();
    const inFamily = !family || [rider.am, rider.pm].some((assignment) => assignment && familyOf(assignment.routeId, assignment.routeName) === family);
    return text.includes(needle) && inFamily && (!attention || needsAttention(rider));
  }).sort((a, b) => a.familyName.localeCompare(b.familyName) || a.givenName.localeCompare(b.givenName));
  const selected = visible.find((rider) => rider.id === selectedId) ?? visible[0] ?? null;
  const pending = guardians.filter((guardian) => guardian.accountStatus === "pending").length;
  const noRoute = riders.filter(hasNoRoute).length;
  const attentionTotal = noRoute + pending;
  const attentionSub = `${noRoute} ${plural(noRoute, "rider", "riders")} with no route · ${pending} ${plural(pending, "account", "accounts")} awaiting setup`;
  const sortedGuardians = [...guardians].sort((a, b) => a.name.localeCompare(b.name));

  async function accountAction(guardian: Guardian, action: GuardianAction) {
    setBusyGuardian(guardian.id);
    setError("");
    try {
      const body = await send("POST", `/api/families/guardians/${guardian.id}/account/${action}`, undefined, "Account action failed.");
      const password = body && typeof body === "object" && "temporaryPassword" in body && typeof body.temporaryPassword === "string" ? body.temporaryPassword : null;
      if (action !== "deactivate" && !password) throw new Error("Server did not return a temporary password.");
      setNotice(action === "activate" ? `${guardian.name} activated. Temporary password: ${password}`
        : action === "reset-password" ? `${guardian.name}'s password reset to ${password}. They must change it at next login.`
          : `${guardian.name}'s login deactivated.`);
      refresh();
    } catch (cause) {
      setError(message(cause, "Account action failed."));
    } finally { setBusyGuardian(null); }
  }

  const accountButtons = (guardian: Guardian) => actionsFor(guardian).map((action) =>
    <button key={action.key} type="button" className={`btn sm${action.primary ? " btn-primary" : ""}`}
      disabled={!!action.disabled || busyGuardian === guardian.id} title={action.disabled}
      onClick={() => void accountAction(guardian, action.key)}>{action.label}</button>);

  const guardianCard = (guardian: Guardian) => <div key={guardian.id} className="gcard">
    <div className="t"><strong>{guardian.name}</strong><Pill status={guardian.accountStatus} guardian /></div>
    <p>{guardian.email ?? "No email on roster"}</p>
    {guardian.phone && <p><a href={`tel:${guardian.phone}`}>{guardian.phone}</a></p>}
    <p>Last signed in: {signedIn(guardian.lastSignedIn)}</p>
    <div className="acts">{accountButtons(guardian)}
      <button type="button" className="btn sm" onClick={() => setOverlay({ type: "guardianForm", id: guardian.id })}>Edit</button></div>
    {guardian.accountStatus === "none" && !guardian.email && <p className="dim" style={{ marginTop: 8 }}>Add an email with Edit to activate a login.</p>}
  </div>;

  const assignLine = (assignment: Rider["am"], period: string) => <div><b>{period}</b>{assignment
    ? <><span className="rdot" style={{ "--c": PALETTE[families.indexOf(familyOf(assignment.routeId, assignment.routeName)) % PALETTE.length] ?? "#a9b3ab" } as CSSProperties} />{assignment.stopLabel}</>
    : <span className="dim">Not assigned</span>}</div>;

  const riderDetail = (rider: Rider) => <>
    <span className="ov">RIDER DETAIL</span>
    <h2 className="dt"><Avatar name={`${rider.givenName} ${rider.familyName}`} color={riderColor(rider)} size={44} />{rider.givenName} {rider.familyName}</h2>
    {hasNoRoute(rider) && <p className="cov-warn">No AM or PM route. No bus will pick {rider.givenName} up.{rider.imported ? " Fix it in the roster file." : " Use Edit rider to choose a route and stop."}</p>}
    <div className="asg">
      <div><b>AM</b>{rider.am ? <>{rider.am.stopLabel} <span className="dim">{rider.am.routeName}</span></> : <span className="dim">Not assigned</span>}</div>
      <div><b>PM</b>{rider.pm ? <>{rider.pm.stopLabel} <span className="dim">{rider.pm.routeName}</span></> : <span className="dim">Not assigned</span>}</div>
    </div>
    <div className="acts">
      {!rider.imported && <button type="button" className="btn sm" onClick={() => setOverlay({ type: "riderForm", id: rider.id })}>Edit rider</button>}
      <button type="button" className="btn sm" onClick={() => setOverlay({ type: "links", id: rider.id })}>Manage guardians</button>
    </div>
    <div className="dv" /><span className="ov">GUARDIANS</span>
    {rider.guardians.map((guardian) => guardianCard(guardians.find((item) => item.id === guardian.id) ?? guardian))}
    {rider.imported && <p className="muted">Imported rider. Assignments come from the roster file.</p>}
  </>;

  const overlayRider = overlay && "id" in overlay && overlay.id ? riders.find((rider) => rider.id === overlay.id) ?? null : null;
  const overlayGuardian = overlay && "id" in overlay && overlay.id ? guardians.find((guardian) => guardian.id === overlay.id) ?? null : null;
  const overlayView = overlay && <Overlay onClose={() => setOverlay(null)}>
    {overlay.type === "rider" && (overlayRider ? riderDetail(overlayRider) : <NoMatch>Not found.</NoMatch>)}
    {overlay.type === "guardian" && (overlayGuardian ? <><span className="ov">GUARDIAN</span><h2 className="dt">{overlayGuardian.name}</h2>
      <p className="muted">Children: {kidsOf(overlayGuardian.id).map((rider) => `${rider.givenName} ${rider.familyName}`).join(", ") || "None linked"}</p>
      {guardianCard(overlayGuardian)}</> : <NoMatch>Not found.</NoMatch>)}
    {overlay.type === "riderForm" && <><span className="ov">ROSTER</span><h2 className="dt">{overlay.id ? "Edit rider" : "Add rider"}</h2>
      <RiderForm rider={overlayRider} guardians={sortedGuardians} riders={riders} routes={routes} onSaved={(id) => {
        setOverlay(null); setSelectedId(id); toast(overlay.id ? "Rider updated." : "Rider added."); refresh();
      }} /></>}
    {overlay.type === "guardianForm" && <><span className="ov">CONTACTS</span><h2 className="dt">{overlay.id ? "Edit guardian" : "Add guardian"}</h2>
      <GuardianForm guardian={overlayGuardian} riders={riders} onSaved={() => {
        setOverlay(null); toast(overlay.id ? "Guardian updated." : "Guardian added to the roster."); refresh();
      }} /></>}
    {overlay.type === "links" && overlayRider && <><span className="ov">GUARDIANS</span><h2 className="dt">{overlayRider.givenName} {overlayRider.familyName}</h2>
      <LinksForm rider={overlayRider} guardians={sortedGuardians} riders={riders} onSaved={() => { setOverlay(null); toast("Rider's guardians updated."); refresh(); }} /></>}
  </Overlay>;

  const status = <>
    <ErrorNote text={error} />
    {notice && <div className="ok-note" role="status"><b>{notice}</b><button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setNotice("")}>Dismiss</button></div>}
    {loading && <p className="hint">Loading roster…</p>}
  </>;
  const emptyText = loading ? "Loading riders…" : riders.length ? "No riders match these filters." : "No roster has been imported yet.";

  if (mode === "desktop") {
    return <>
      <Head eyebrow="Families" title="Riders & guardians" sub="Assignments and family access in one place." actions={<>
        <button type="button" className="btn" onClick={() => setOverlay({ type: "guardianForm", id: null })}>Add guardian</button>
        <button type="button" className="btn btn-primary" onClick={() => setOverlay({ type: "riderForm", id: null })}>Add rider</button></>} />
      {status}
      <div className="tiles">
        <Tile label="Riders listed" value={riders.length} sub="Riders in the roster" />
        <Tile label="Guardians listed" value={guardians.length} sub="Unique roster contacts" />
        <Tile label="Needs attention" value={attentionTotal} sub={attentionSub} className={`${attentionTotal ? "bad" : "good"}${attention ? " on" : ""}`}
          pressed={attention} onClick={() => { setAttention(!attention); setView("riders"); }} />
      </div>
      <div className="tabs2" role="tablist">{([["riders", "Rider roster"], ["guardians", "Guardians"]] as const).map(([key, label]) =>
        <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "on" : ""} onClick={() => setView(key)}>{label}</button>)}</div>
      {view === "riders" ? <>
        <div className="filters" style={{ marginTop: 16 }}>
          <Search label="Find a rider or guardian" value={query} onChange={setQuery} placeholder="Search names or route" />
          <label>Route<select value={family} onChange={(event) => setFamily(event.target.value)}>
            <option value="">All routes</option>{families.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label className="ck"><input type="checkbox" checked={attention} onChange={(event) => setAttention(event.target.checked)} /> Needs attention only</label>
          <span className="cnt">{visible.length} of {riders.length} riders</span>
        </div>
        <div className="split">
          <div className="scr"><table className="tbl"><thead><tr><th>Child</th><th>AM pickup / PM drop-off</th><th>Guardians &amp; access</th><th>Account status</th></tr></thead>
            <tbody>{visible.length ? visible.map((rider) => <tr key={rider.id} data-set="" tabIndex={0} className={rider.id === selected?.id ? "sel" : ""}
              onClick={() => setSelectedId(rider.id)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedId(rider.id); }}>
              <td><div className="who"><Avatar name={`${rider.givenName} ${rider.familyName}`} color={riderColor(rider)} size={36} /><strong>{rider.givenName} {rider.familyName}</strong><CoverageTag rider={rider} /></div></td>
              <td><div className="st2">{assignLine(rider.am, "AM")}{assignLine(rider.pm, "PM")}</div></td>
              <td>{rider.guardians.length} linked {plural(rider.guardians.length, "guardian", "guardians")}</td>
              <td><Pill status={riderStatus(rider)} /></td></tr>)
              : <tr><td colSpan={4} className="nomatch">{emptyText}</td></tr>}</tbody></table></div>
          <aside className="rdetail">{selected ? riderDetail(selected) : <><span className="ov">DETAIL</span><h2 className="dt">Choose a rider</h2></>}</aside>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>Buses are assigned to trips, not permanently to children or routes.</p>
      </> : <>
        <div style={{ marginTop: 16 }}><table className="tbl"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Children</th><th>Account</th><th>Action</th></tr></thead>
          <tbody>{sortedGuardians.length ? sortedGuardians.map((guardian) => <tr key={guardian.id}>
            <td><strong>{guardian.name}</strong></td>
            <td>{guardian.email ?? <span className="dim">&mdash;</span>}</td>
            <td>{guardian.phone ?? <span className="dim">&mdash;</span>}</td>
            <td>{kidsOf(guardian.id).map((rider) => rider.givenName).join(", ") || <span className="dim">None</span>}</td>
            <td><Pill status={guardian.accountStatus} guardian /></td>
            <td><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{accountButtons(guardian)}
              <button type="button" className="btn sm" onClick={() => setOverlay({ type: "guardianForm", id: guardian.id })}>Edit</button></div></td>
          </tr>) : <tr><td colSpan={6} className="nomatch">No guardian contacts yet.</td></tr>}</tbody></table></div>
        <p className="hint" style={{ marginTop: 12 }}>A contact record alone is not a login. Guardians need an activated login to see the bus and read messages.</p>
      </>}
      {overlayView}
    </>;
  }

  return <>
    <Head eyebrow="Families" title="Riders" sub={<>{riders.length} riders &middot; {guardians.length} guardians</>}
      actions={<Plus label="Add" onClick={() => setOverlay(view === "riders" ? { type: "riderForm", id: null } : { type: "guardianForm", id: null })} />} />
    <Seg label="View" value={view} onChange={setView} items={[["riders", "Riders"], ["guardians", "Guardians"]]} />
    {status}
    {view === "riders" ? <>
      <Search value={query} onChange={setQuery} placeholder="Search names or route" />
      <div className="chips"><button type="button" className={`chip${attention ? " on" : ""}`} aria-pressed={attention} onClick={() => setAttention(!attention)}>NEEDS ATTENTION <b>{attentionTotal}</b></button></div>
      <div className="cards">{visible.length ? visible.map((rider) => <button key={rider.id} type="button" className="bc" style={{ "--c": riderColor(rider) } as CSSProperties}
        onClick={() => setOverlay({ type: "rider", id: rider.id })}>
        <div className="h"><strong>{rider.givenName} {rider.familyName}</strong><span className="tags"><CoverageTag rider={rider} /><Pill status={riderStatus(rider)} /></span></div>
        <div className="st2">{assignLine(rider.am, "AM")}{assignLine(rider.pm, "PM")}</div>
        <div className="tm"><span>{rider.guardians.length} linked {plural(rider.guardians.length, "guardian", "guardians")}</span></div>
      </button>) : <NoMatch>{emptyText}</NoMatch>}</div>
    </> : <div className="cards" style={{ marginTop: 12 }}>{sortedGuardians.map((guardian) =>
      <button key={guardian.id} type="button" className="bc" style={{ "--c": "#a9b3ab" } as CSSProperties} onClick={() => setOverlay({ type: "guardian", id: guardian.id })}>
        <div className="h"><strong>{guardian.name}</strong><Pill status={guardian.accountStatus} guardian /></div>
        <div className="tm"><span>{kidsOf(guardian.id).map((rider) => rider.givenName).join(", ") || "No children linked"}</span></div>
      </button>)}</div>}
    {overlayView}
  </>;
}
