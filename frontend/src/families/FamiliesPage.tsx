import { useEffect, useState, type FormEvent } from "react";
import {
  guardianInputSchema, guardiansResponseSchema, riderInputSchema, rosterResponseSchema,
  routesResponseSchema, type Guardian, type Rider, type Route
} from "@bussin/shared";

type View = "roster" | "guardians" | "trips" | "signins";
type Direction = "am" | "pm";
type Draft = {
  givenName: string; familyName: string; guardianIds: string[];
  amRoute: string; amStop: string; pmRoute: string; pmStop: string;
};

const blankDraft: Draft = {
  givenName: "", familyName: "", guardianIds: [],
  amRoute: "", amStop: "", pmRoute: "", pmStop: ""
};
const views: { id: View; label: string }[] = [
  { id: "roster", label: "Rider roster" },
  { id: "guardians", label: "Guardians" },
  { id: "trips", label: "Trip history" },
  { id: "signins", label: "Sign-in history" }
];

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className="family-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function EmptyDetail({ title, description }: { title: string; description: string }) {
  return <aside className="family-detail"><span className="family-overline">DETAIL</span><h2>{title}</h2><p>{description}</p></aside>;
}

function stopDescription(assignment: Rider["am"]) {
  return assignment ? `${assignment.stopLabel} · ${assignment.routeName}` : "Not assigned";
}

async function errorFrom(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  return new Error(body && typeof body === "object" && "error" in body &&
    typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
}

function AssignmentFields({
  direction, draft, routes, change
}: {
  direction: Direction;
  draft: Draft;
  routes: Route[];
  change: (next: Partial<Draft>) => void;
}) {
  const routeKey = direction === "am" ? "amRoute" : "pmRoute";
  const stopKey = direction === "am" ? "amStop" : "pmStop";
  const servicePeriod = direction.toUpperCase() as Route["servicePeriod"];
  const selectedRoute = routes.find((route) => route.id === draft[routeKey] &&
    route.servicePeriod === servicePeriod);
  return (
    <div className="family-assignment-fields">
      <label>{direction.toUpperCase()} route
        <select
          value={draft[routeKey]}
          onChange={(event) => change({ [routeKey]: event.target.value, [stopKey]: "" })}
        >
          <option value="">No {direction.toUpperCase()} assignment</option>
          {routes.filter((route) => route.servicePeriod === servicePeriod &&
            (route.active || route.id === draft[routeKey])).map((route) => (
            <option key={route.id} value={route.id}>
              {route.name}{route.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </label>
      <label>{direction.toUpperCase()} stop
        <select
          value={draft[stopKey]}
          disabled={!selectedRoute}
          onChange={(event) => change({ [stopKey]: event.target.value })}
        >
          <option value="">Choose a stop</option>
          {selectedRoute?.stops.map((stop) => (
            <option key={stop.id} value={stop.id}>{stop.position}. {stop.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function FamiliesPage() {
  const [view, setView] = useState<View>("roster");
  const [riders, setRiders] = useState<Rider[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [routeFilter, setRouteFilter] = useState("");
  const [needsAttention, setNeedsAttention] = useState(false);
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [saving, setSaving] = useState(false);
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [linkRiderId, setLinkRiderId] = useState("");
  const [linkGuardianIds, setLinkGuardianIds] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianError, setGuardianError] = useState("");
  const [editingGuardianId, setEditingGuardianId] = useState<string | null>(null);
  const [addingGuardian, setAddingGuardian] = useState(false);
  const [accountActionId, setAccountActionId] = useState<string | null>(null);

  function editGuardian(guardian: Rider["guardians"][number]) {
    setEditingGuardianId(guardian.id);
    setGuardianName(guardian.name);
    setGuardianEmail(guardian.email ?? "");
    setView("guardians");
    setGuardianPhone(guardian.phone ?? "");
    setGuardianError("");
    setNotice("");
  }

  function resetGuardianForm() {
    setEditingGuardianId(null);
    setGuardianName("");
    setGuardianEmail("");
    setGuardianPhone("");
    setGuardianError("");
  }

  async function refresh(signal?: AbortSignal) {
    const response = await fetch("/api/families/roster", { credentials: "same-origin", signal });
    if (!response.ok) throw await errorFrom(response);
    setRiders(rosterResponseSchema.parse(await response.json()).riders);
    const contacts = await fetch("/api/families/guardians", { credentials: "same-origin", signal });
    if (!contacts.ok) throw await errorFrom(contacts);
    setGuardians(guardiansResponseSchema.parse(await contacts.json()).guardians);
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [roster, routeResponse, contacts] = await Promise.all([
          fetch("/api/families/roster", { credentials: "same-origin", signal: controller.signal }),
          fetch("/api/routes", { credentials: "same-origin", signal: controller.signal }),
          fetch("/api/families/guardians", { credentials: "same-origin", signal: controller.signal })
        ]);
        if (!roster.ok) throw await errorFrom(roster);
        if (!routeResponse.ok) throw await errorFrom(routeResponse);
        if (!contacts.ok) throw await errorFrom(contacts);
        const [riderData, routeData, guardianData] = await Promise.all([roster.json(), routeResponse.json(), contacts.json()]);
        if (!controller.signal.aborted) {
          setRiders(rosterResponseSchema.parse(riderData).riders);
          setRoutes(routesResponseSchema.parse(routeData).routes);
          setGuardians(guardiansResponseSchema.parse(guardianData).guardians);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load roster.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  function startEditing(rider?: Rider) {
    setEditingId(rider?.id ?? null);
    setDraft(rider ? {
      givenName: rider.givenName, familyName: rider.familyName,
      guardianIds: rider.guardians.map((guardian) => guardian.id),
      amRoute: rider.am?.routeId ?? "", amStop: rider.am?.stopId ?? "",
      pmRoute: rider.pm?.routeId ?? "", pmStop: rider.pm?.stopId ?? ""
    } : blankDraft);
    setError("");
    setNotice("");
  }

  async function saveRider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if ((draft.amRoute && !draft.amStop) || (draft.pmRoute && !draft.pmStop)) {
      setError("Choose a stop for each selected route.");
      return;
    }
    const input = riderInputSchema.safeParse({
      givenName: draft.givenName, familyName: draft.familyName,
      am: draft.amRoute ? { routeId: draft.amRoute, stopId: draft.amStop } : null,
      pm: draft.pmRoute ? { routeId: draft.pmRoute, stopId: draft.pmStop } : null,
      guardianIds: draft.guardianIds
    });
    if (!input.success) {
      setError("Enter the rider's name, at least one guardian, and valid stops.");
      return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(editingId ? `/api/families/riders/${editingId}` : "/api/families/riders", {
        method: editingId ? "PUT" : "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data)
      });
      if (!response.ok) throw await errorFrom(response);
      const saved: unknown = await response.json();
      if (!saved || typeof saved !== "object" || !("id" in saved) || typeof saved.id !== "string") {
        throw new Error("Rider was saved, but the response was incomplete. Refresh the roster.");
      }
      await refresh();
      setSelectedId(saved.id);
      setEditingId(undefined);
      setGuardianError("");
      setNotice(editingId ? "Rider updated." : "Rider added.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save rider.");
    } finally { setSaving(false); }
  }

  async function addGuardian(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = guardianInputSchema.safeParse({
      name: guardianName, email: guardianEmail.trim() || null, phone: guardianPhone.trim() || null
    });
    if (!parsed.success) { setGuardianError("Enter a guardian name, or correct the optional email and phone."); return; }
    setAddingGuardian(true); setGuardianError(""); setNotice("");
    try {
      const response = await fetch(editingGuardianId
        ? `/api/families/guardians/${editingGuardianId}` : "/api/families/guardians", {
        method: editingGuardianId ? "PUT" : "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(editingGuardianId ? parsed.data : { ...parsed.data, riderId: linkRiderId || null })
      });
      if (!response.ok) throw await errorFrom(response);
      await refresh();
      setNotice(editingGuardianId ? "Guardian updated." : "Guardian added to the roster.");
      resetGuardianForm();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save guardian.";
      setGuardianError(message);
    } finally { setAddingGuardian(false); }
  }

  async function runGuardianAccountAction(
    guardian: Guardian,
    action: "activate" | "deactivate" | "reset-password"
  ) {
    setAccountActionId(guardian.id);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        `/api/families/guardians/${guardian.id}/account/${action}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" }
        }
      );

      if (!response.ok) throw await errorFrom(response);

      const body: unknown = await response.json();

      await refresh();

      if (action === "activate") {
        setNotice(`${guardian.name} activated. Temporary password: genericpassword`);
      } else if (action === "reset-password") {
        setNotice(`${guardian.name}'s password reset to genericpassword. They must change it at next login.`);
      } else {
        setNotice(`${guardian.name}'s login deactivated.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account action failed.");
    } finally {
      setAccountActionId(null);
    }
  }

  async function saveGuardianLinks(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!linkRiderId) return;
    setLinking(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/families/riders/${linkRiderId}/guardians`, {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guardianIds: linkGuardianIds })
      });
      if (!response.ok) throw await errorFrom(response);
      await refresh();
      setNotice("Rider's guardians updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update guardian links.");
    } finally { setLinking(false); }
  }

  const matching = riders.filter((rider) => {
    const terms = [rider.givenName, rider.familyName,
      ...rider.guardians.map((guardian) => `${guardian.name} ${guardian.email ?? ""}`),
      rider.am?.routeName ?? "", rider.pm?.routeName ?? ""].join(" ").toLowerCase();
    return terms.includes(search.toLowerCase()) &&
      (!routeFilter || rider.am?.routeId === routeFilter || rider.pm?.routeId === routeFilter) &&
      (!needsAttention || rider.guardians.some((guardian) => guardian.accountStatus === "pending"));
  });
  const selected = matching.find((rider) => rider.id === selectedId) ?? matching[0];
  const guardianCount = guardians.length;
  const pendingCount = guardians.filter((guardian) => guardian.accountStatus === "pending").length;

  return (
    <div className="families-page">
      <div className="family-heading"><p className="eyebrow">FAMILIES / OPERATIONS</p>
        <h1>Riders &amp; guardians</h1>
        <p className="description">Assignments and family access in one place.</p>
      </div>
      <div className="family-metrics" aria-label="Operations summary">
        <Metric label="Riders listed" value={loading || error && !riders.length ? "—" : riders.length} detail="Riders in the roster" />
        <Metric label="Guardians listed" value={loading || error && !riders.length ? "—" : guardianCount} detail="Unique roster contacts" />
        <Metric label="Needs attention" value={loading || error && !riders.length ? "—" : pendingCount} detail="Accounts awaiting setup" />
        <Metric label="Trips shown" value="—" detail="History not connected here yet" />
      </div>

      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <section className="family-surface" aria-label="Rider and guardian operations">
        <div className="family-surface-header"><div className="family-tabs" role="tablist" aria-label="Operations views">
          {views.map(({ id, label }) => <button key={id} id={`family-tab-${id}`} type="button" role="tab"
            aria-controls="family-panel" aria-selected={view === id} tabIndex={view === id ? 0 : -1}
            onClick={() => setView(id)} onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const index = views.findIndex((option) => option.id === view);
              const next = views[(index + (event.key === "ArrowRight" ? 1 : views.length - 1)) % views.length];
              setView(next.id);
              document.getElementById(`family-tab-${next.id}`)?.focus();
            }}>{label}</button>)}
        </div></div>
        <div id="family-panel" role="tabpanel" aria-labelledby={`family-tab-${view}`} tabIndex={0}>
          {view === "roster" && <>
            <div className="family-controls">
              <label htmlFor="family-search">Find a rider or guardian
                <input id="family-search" type="search" placeholder="Search names or route"
                  value={search} onChange={(event) => setSearch(event.target.value)} disabled={loading || !!error && !riders.length} />
              </label>
              <label htmlFor="family-route">Route
                <select id="family-route" value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)}>
                  <option value="">All routes</option>
                  {routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}
                </select>
              </label>
              <label className="family-check"><input type="checkbox" checked={needsAttention}
                onChange={(event) => setNeedsAttention(event.target.checked)} /> Needs attention only</label>
              <button type="button" className="family-action" onClick={() => {
                startEditing();
                requestAnimationFrame(() =>
                  document.getElementById("family-rider-editor")?.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                  })
                );
              }}>Add rider</button>
              <span className="family-count">{loading ? "Loading…" : `${matching.length} of ${riders.length} riders`}</span>
            </div>
            <div className="family-layout"><div className="family-table-scroll"><table className="family-table">
              <thead><tr><th scope="col">Child</th><th scope="col">AM pickup / PM drop-off</th>
                <th scope="col">Routes</th><th scope="col">Guardians &amp; access</th><th scope="col">Account status</th></tr></thead>
              <tbody>{matching.map((rider) => <tr key={rider.id} className={selected?.id === rider.id ? "family-selected" : ""}>
                <td><button className="family-row-button" type="button" onClick={() => setSelectedId(rider.id)}>
                  {rider.givenName} {rider.familyName}</button></td>
                <td>AM: {rider.am?.stopLabel ?? "Not assigned"}<br />PM: {rider.pm?.stopLabel ?? "Not assigned"}</td>
                <td>{rider.am?.routeName ?? "—"}<br />{rider.pm?.routeName ?? "—"}</td>
                <td>{rider.guardians.length} linked {rider.guardians.length === 1 ? "guardian" : "guardians"}</td>
                <td>{rider.guardians.some((guardian) => guardian.accountStatus === "pending") ? "Setup needed" : rider.guardians.some((guardian) => guardian.accountStatus === "active") ? "Account active" : "No account linked"}</td>
              </tr>)}
              {!matching.length && <tr><td colSpan={5} className="family-empty-cell">
                {loading ? "Loading riders…" : error && !riders.length ? "Roster unavailable." :
                  riders.length ? "No riders match these filters." : "No roster has been imported yet."}
              </td></tr>}</tbody>
            </table></div>
              {selected ? <aside className="family-detail"><span className="family-overline">RIDER DETAIL</span>
                <h2>{selected.givenName} {selected.familyName}</h2>
                <p>AM pickup: {stopDescription(selected.am)}</p>
                <p>PM drop-off: {stopDescription(selected.pm)}</p>
                <div className="family-divider" /><span className="family-overline">GUARDIANS</span>
                {selected.guardians.map((guardian) => <div className="family-guardian" key={guardian.id}>
                  <strong>{guardian.name}</strong><p>{guardian.email ?? "No email on roster"}</p>
                  {guardian.phone && <p>{guardian.phone}</p>}
                  <p>{guardian.accountStatus === "active" ? "Account active" : guardian.accountStatus === "pending" ? "Account setup needed" : "No login account linked"}</p>
                  <p>Last signed in: {guardian.lastSignedIn ? new Date(guardian.lastSignedIn).toLocaleString() : "Never"}</p>
                  <button type="button" className="family-edit-guardian" onClick={() => editGuardian(guardian)}>Edit guardian</button>
                </div>)}
                {!selected.imported && <button type="button" className="family-action" onClick={() => startEditing(selected)}>Edit rider</button>}
                <button type="button" className="family-edit-guardian" onClick={() => { setLinkRiderId(selected.id); setLinkGuardianIds(selected.guardians.map((g) => g.id)); setView("guardians"); }}>Manage guardians</button>
              </aside> : <EmptyDetail title="Choose a rider" description="Assigned stops and guardian accounts will appear here." />}
            </div>
            <p className="family-footnote">Buses are assigned to trips, not permanently to children or routes. Alert delivery is not connected to this roster yet.</p>
          </>}
          {view === "guardians" && <>
            <div className="family-controls"><strong>Guardian contacts</strong>
              <button type="button" className="family-action" onClick={() => {
                resetGuardianForm();
                document.getElementById("family-add-guardian")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}>Add guardian</button>
              <span className="family-count">{guardians.length} contacts</span>
            </div>
            <div className="family-table-scroll"><table className="family-table">
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th>
                <th scope="col">Phone</th><th scope="col">Account</th><th scope="col">Action</th></tr></thead>
              <tbody>{guardians.map((guardian) => <tr key={guardian.id}>
                <td>{guardian.name}</td><td>{guardian.email ?? "—"}</td>
                <td>{guardian.phone ?? "—"}</td>
                <td>{guardian.accountStatus === "active" ? "Active" : guardian.accountStatus === "pending" ? "Setup needed" : "No account linked"}</td>
                <td>
                  <button type="button" className="family-edit-guardian"
                    onClick={() => editGuardian(guardian)}>Edit</button>
                  {guardian.accountStatus === "none" && <button
                    type="button"
                    className="family-action"
                    disabled={accountActionId === guardian.id || !guardian.email}
                    onClick={() => void runGuardianAccountAction(guardian, "activate")}
                  >{accountActionId === guardian.id ? "Activating…" : "Activate account"}</button>}
                  {guardian.accountStatus === "active" && <>
                    <button
                      type="button"
                      className="family-edit-guardian"
                      disabled={accountActionId === guardian.id}
                      onClick={() => void runGuardianAccountAction(guardian, "reset-password")}
                    >Reset password</button>
                    <button
                      type="button"
                      className="family-edit-guardian"
                      disabled={accountActionId === guardian.id}
                      onClick={() => void runGuardianAccountAction(guardian, "deactivate")}
                    >Deactivate</button>
                  </>}
                  {guardian.accountStatus === "pending" && <button
                    type="button"
                    className="family-action"
                    disabled={accountActionId === guardian.id}
                    onClick={() => void runGuardianAccountAction(guardian, "activate")}
                  >Reactivate account</button>}
                </td>
              </tr>)}
              {!guardians.length && <tr><td colSpan={5} className="family-empty-cell">No guardian contacts yet. Add one below or import a roster.</td></tr>}</tbody>
            </table></div>
            <p className="family-footnote">A contact record does not create a login or subscribe anyone to alerts.</p>
          </>}
          {view === "trips" && <><div className="family-layout"><div className="family-table-scroll">
            <table className="family-table"><thead><tr><th scope="col">Date</th><th scope="col">Bus</th>
              <th scope="col">Route</th><th scope="col">Departure</th><th scope="col">Status</th></tr></thead>
              <tbody><tr><td colSpan={5} className="family-empty-cell">Trip history is not connected to this screen yet. Use Dispatch for planned trips.</td></tr></tbody></table>
          </div><EmptyDetail title="Trip history" description="Recorded stop events will appear here when connected." /></div>
            <p className="family-footnote">Scheduled, estimated and actual times are separate facts.</p></>}
          {view === "signins" && <><div className="family-layout"><div className="family-table-scroll">
            <table className="family-table"><thead><tr><th scope="col">Account</th><th scope="col">Event</th>
              <th scope="col">When</th><th scope="col">Type</th></tr></thead>
              <tbody><tr><td colSpan={4} className="family-empty-cell">Sign-in event history is not recorded yet. The roster shows the last successful sign-in for linked guardians.</td></tr></tbody></table>
          </div><EmptyDetail title="Sign-in history" description="An audit event log will appear here when the app records one." /></div>
            <p className="family-footnote">A recent sign-in does not mean someone is viewing the app now.</p></>}
        </div>
      </section>

      <section className="family-management" aria-label="Roster source">
        <div className="family-management-head"><h2>Roster source</h2></div>
        <p>Load the roster before testing. Use the Guardians tab to add or correct contacts. Reimporting updates imported contact details from the source file.</p>
        {editingId !== undefined && <form id="family-rider-editor" className="family-editor" onSubmit={(event) => void saveRider(event)}>
          <h3>{editingId ? "Edit rider" : "Add rider"}</h3>
          <div className="family-editor-grid">
            <label>Child's first name<input value={draft.givenName} maxLength={80} required
              onChange={(event) => setDraft((current) => ({ ...current, givenName: event.target.value }))} /></label>
            <label>Child's last name<input value={draft.familyName} maxLength={80} required
              onChange={(event) => setDraft((current) => ({ ...current, familyName: event.target.value }))} /></label>
          </div>
          <label>Guardians
            <select multiple value={draft.guardianIds} onChange={(event) => setDraft((current) => ({ ...current, guardianIds: Array.from(event.target.selectedOptions, (option) => option.value) }))}>
              {guardians.map((guardian) => <option key={guardian.id} value={guardian.id}>{guardian.name}</option>)}
            </select>
          </label>
          <AssignmentFields direction="am" draft={draft} routes={routes}
            change={(next) => setDraft((current) => ({ ...current, ...next }))} />
          <AssignmentFields direction="pm" draft={draft} routes={routes}
            change={(next) => setDraft((current) => ({ ...current, ...next }))} />
          <div className="family-form-actions"><button className="family-action" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save rider"}</button><button type="button" onClick={() => setEditingId(undefined)}>Cancel</button></div>
        </form>}
        {view === "guardians" && <form id="family-add-guardian" className="family-editor family-guardian-form" onSubmit={(event) => void addGuardian(event)}>
          <h3>{editingGuardianId ? "Edit guardian" : "Add guardian"}</h3>
          {guardianError && <p className="auth-error" role="alert">{guardianError}</p>}
          <p className="family-hint">A guardian contact is separate from a login account. Imported contact edits may be replaced by a later import.</p>
          <div className="family-editor-grid">
            <label>Guardian name<input value={guardianName} maxLength={120} required
              onChange={(event) => setGuardianName(event.target.value)} /></label>
            <label>Email (optional)<input type="email" value={guardianEmail}
              onChange={(event) => setGuardianEmail(event.target.value)} /></label>
            <label>Phone (optional)
              <input type="tel" placeholder="Phone number" value={guardianPhone}
                onChange={(event) => setGuardianPhone(event.target.value)} /></label>
          </div>
          {!editingGuardianId && <label>Link to rider (optional)<select value={linkRiderId} onChange={(event) => setLinkRiderId(event.target.value)}>
            <option value="">No rider yet</option>{riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.givenName} {rider.familyName}</option>)}
          </select></label>}
          <button className="family-action" type="submit" disabled={addingGuardian}>
            {addingGuardian ? "Saving…" : editingGuardianId ? "Save guardian" : "Add guardian"}</button>
          {editingGuardianId && <button type="button" onClick={resetGuardianForm}>Cancel</button>}
        </form>}
        {view === "guardians" && <form className="family-editor family-guardian-form" onSubmit={(event) => void saveGuardianLinks(event)}>
          <h3>Link existing guardians to a rider</h3>
          <label>Rider<select value={linkRiderId} onChange={(event) => {
            const id = event.target.value;
            setLinkRiderId(id);
            setLinkGuardianIds(riders.find((rider) => rider.id === id)?.guardians.map((guardian) => guardian.id) ?? []);
          }}><option value="">Choose a rider</option>
            {riders.map((rider) => <option key={rider.id} value={rider.id}>{rider.givenName} {rider.familyName}</option>)}
          </select></label>
          {linkRiderId && <fieldset className="family-guardian-choices"><legend>Guardian contacts</legend>
            {guardians.map((guardian) => <label key={guardian.id}><input type="checkbox"
              checked={linkGuardianIds.includes(guardian.id)}
              onChange={(event) => setLinkGuardianIds((current) => event.target.checked
                ? [...current, guardian.id] : current.filter((id) => id !== guardian.id))} /> {guardian.name}</label>)}
          </fieldset>}
          <p className="family-hint">Imported links come from the roster file and cannot be removed here. Additional links you make here survive reimport.</p>
          <button className="family-action" type="submit" disabled={!linkRiderId || linking}>{linking ? "Saving…" : "Save guardians"}</button>
        </form>}
      </section>
    </div>
  );
}
