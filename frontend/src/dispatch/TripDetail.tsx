import { useEffect, useState, type CSSProperties } from "react";
import {
  assignTripCrewSchema, dispatchGpsAuditResponseSchema,
  type BoardTrip, type Bus, type Route, type DispatchGpsAuditEntry, type TripDriver, type TripStaff
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { age, duration, time, timeWithSeconds } from "../ops/format";
import {
  canComplete, currentStopIndex, presence, stopEta, stopsDone, timing, trackingText,
  type BusRow
} from "../ops/fleetModel";
import type { TripActions } from "../ops/useTripActions";
import { Confirm, CrewPills, Swatch } from "../ops/ui";
import { EditTripForm } from "./EditTripForm";

export function TripPill({ status }: { status: BoardTrip["status"] }) {
  return <span className={`st st-t-${status}`}>{status === "active" ? "Running" : status}</span>;
}

export function StopMiniLine({ trip, color }: { trip: BoardTrip; color: string }) {
  return <div className="mini" style={{ "--c": color } as CSSProperties} aria-label={`${stopsDone(trip)} of ${trip.stops.length} stops done`}>
    {trip.stops.map((stop, index) => <span key={stop.id} title={stop.label}
      className={stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt) ? "on" : ""} />)}
  </div>;
}

export function ConfirmFor({ trip, actions }: { trip: BoardTrip; actions: TripActions }) {
  const pending = actions.pending;
  if (!pending || pending.tripId !== trip.id) return null;
  if (pending.type === "start") {
    return <Confirm text={`Scheduled for ${time(trip.departureAt)}. Start ${pending.early} minutes early?`}
      yes="Start now" onYes={actions.confirm} onNo={actions.dismiss} busy={actions.busy} />;
  }
  return <Confirm danger text={pending.type === "cancel"
    ? `Cancel ${trip.busLabel} ${trip.routeName}? It cannot be restarted.` : "Complete this trip?"}
    yes={pending.type === "cancel" ? "Yes, cancel" : "Yes, complete"} onYes={actions.confirm} onNo={actions.dismiss} busy={actions.busy} />;
}

// The crew for one trip: driver, lead counselor, up to 3 more counselors.
// Before the trip starts everything can change. While it runs, only the driver
// can be swapped (a mid-route handoff); the history keeps both drivers.
function CrewAssign({ trip, staff, drivers, onSaved, toast }: {
  trip: BoardTrip; staff: TripStaff[]; drivers: TripDriver[]; onSaved: () => void; toast: (text: string) => void;
}) {
  const now = {
    driverId: trip.driver?.id ?? "",
    leadId: trip.assignedStaff?.id ?? "",
    counselorIds: trip.counselors.map((c) => c.id)
  };
  const key = `${trip.id}|${now.driverId}|${now.leadId}|${now.counselorIds.join(",")}`;
  const [driverId, setDriverId] = useState(now.driverId);
  const [leadId, setLeadId] = useState(now.leadId);
  const [counselorIds, setCounselorIds] = useState<string[]>(now.counselorIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDriverId(now.driverId); setLeadId(now.leadId); setCounselorIds(now.counselorIds); setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const planned = trip.status === "planned";
  const nameOf = (id: string) => staff.find((p) => p.id === id)?.displayName
    ?? trip.counselors.find((c) => c.id === id)?.displayName ?? (trip.assignedStaff?.id === id ? trip.assignedStaff.displayName : "Staff");
  const changed = driverId !== now.driverId || leadId !== now.leadId || counselorIds.join(",") !== now.counselorIds.join(",");
  const addable = staff.filter((p) => p.id !== leadId && !counselorIds.includes(p.id));
  // A driver on the trip who has since been retired still shows, so the picker never hides who's driving.
  const driverOptions = trip.driver && !drivers.some((d) => d.id === trip.driver!.id) ? [trip.driver, ...drivers] : drivers;

  async function save() {
    const parsed = assignTripCrewSchema.safeParse({ driverId: driverId || null, leadId: leadId || null, counselorIds });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the crew."); return; }
    setSaving(true);
    setError("");
    try {
      await send("PUT", `/api/dispatch/trips/${trip.id}/crew`, parsed.data, "Could not save the crew.");
      toast(`Crew saved for ${trip.busLabel}.`);
      onSaved();
    } catch (cause) {
      setError(message(cause, "Could not save the crew."));
    } finally {
      setSaving(false);
    }
  }

  return <div className="dblock crew">
    <h3>Crew</h3>
    <label className="lt" htmlFor={`driver-${trip.id}`}>Driver</label>
    <select id={`driver-${trip.id}`} value={driverId} disabled={saving} onChange={(event) => setDriverId(event.target.value)}>
      <option value="">No driver set</option>
      {driverOptions.map((d) => <option key={d.id} value={d.id}>{d.name}{d.phone ? ` · ${d.phone}` : ""}</option>)}
    </select>
    {!drivers.length && !trip.driver && <span className="hint">Add drivers in Data → Drivers.</span>}

    <label className="lt" htmlFor={`lead-${trip.id}`}>Lead counselor</label>
    <select id={`lead-${trip.id}`} value={leadId} disabled={saving || !planned}
      onChange={(event) => { const next = event.target.value; setLeadId(next); setCounselorIds((c) => c.filter((id) => id !== next)); }}>
      <option value="">No lead yet</option>
      {leadId && !staff.some((p) => p.id === leadId) && <option value={leadId}>{nameOf(leadId)}</option>}
      {staff.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
    </select>

    <span className="lt">Other counselors <small>({counselorIds.length} of 3)</small></span>
    <div className="crew-chips">
      {counselorIds.map((id) => <span key={id} className="crew-chip">{nameOf(id)}
        {planned && <button type="button" aria-label={`Remove ${nameOf(id)}`} disabled={saving}
          onClick={() => setCounselorIds((c) => c.filter((x) => x !== id))}>&times;</button>}</span>)}
      {!counselorIds.length && <span className="hint">None</span>}
    </div>
    {planned && counselorIds.length < 3 && <select aria-label="Add a counselor" value="" disabled={saving || !addable.length}
      onChange={(event) => { const id = event.target.value; if (id) setCounselorIds((c) => [...c, id]); }}>
      <option value="">{addable.length ? "Add a counselor…" : "No more staff to add"}</option>
      {addable.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
    </select>}

    {!planned && <span className="hint">The trip is running: only the driver can be swapped.</span>}
    {planned && !leadId && <span className="hint">Pick a lead counselor before starting this trip.</span>}
    {error && <p className="crew-err" role="alert">{error}</p>}
    <div className="acts" style={{ margin: "10px 0 0" }}>
      <button type="button" className="btn btn-primary" disabled={saving || !changed} onClick={() => void save()}>
        {saving ? "Saving…" : "Save crew"}
      </button>
      {changed && !saving && <button type="button" className="btn" onClick={() => {
        setDriverId(now.driverId); setLeadId(now.leadId); setCounselorIds(now.counselorIds); setError("");
      }}>Undo changes</button>}
    </div>
  </div>;
}

function GpsLog({ tripId }: { tripId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DispatchGpsAuditEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = () => getJson(`/api/dispatch/trips/${tripId}/gps-audit`, dispatchGpsAuditResponseSchema, controller.signal)
      .then((data) => { setEntries(data.entries); setError(""); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load GPS capture log.")); });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [tripId, open]);

  const count = entries.filter((entry) => entry.kind === "sample").length;
  return <details className="ops-log" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary>GPS capture log{open ? ` · ${count} captured` : ""}</summary>
    {error ? <p className="err" role="alert">{error}</p> : !entries.length ? <p className="hint" style={{ padding: "0 12px" }}>No GPS captures yet.</p> :
      <ol className="gl">{entries.map((entry) => entry.kind === "sample"
        ? <li key={entry.id}><time>{timeWithSeconds(entry.observedAt)}</time><strong>GPS CAPTURE</strong>
          <span>&plusmn;{Math.round(entry.accuracyM)} m · {entry.speedMps === null ? "speed unknown" : `${(entry.speedMps * 2.23694).toFixed(1)} mph`}</span></li>
        : entry.kind === "journey"
          ? <li key={entry.id} className="j"><time>{timeWithSeconds(entry.occurredAt)}</time>
            <strong>{entry.action === "arrived_stop" ? "AUTO ARRIVED" : "AUTO DEPARTED"}</strong><span>{entry.stopLabel}</span></li>
          : entry.kind === "correction"
            ? <li key={entry.id} className="g"><time>{timeWithSeconds(entry.occurredAt)}</time>
              <strong>ARRIVAL UNDONE</strong><span>{entry.stopLabel}</span></li>
            : <li key={entry.id} className="g"><time>{timeWithSeconds(entry.resumedAt)}</time>
              <strong>GPS RESUMED</strong><span>No accepted captures for {duration(entry.durationSeconds)}</span></li>)}
      </ol>}
  </details>;
}

/** Stops in route order with actual times, AUTO/MANUAL tags, and live ETA with minutes away. */
export function StopsList({ trip, color, actions, readOnly, now }: {
  trip: BoardTrip; color: string; actions: TripActions; readOnly?: boolean; now: number;
}) {
  const current = trip.status === "active" ? currentStopIndex(trip) : -1;
  const source = trip.status !== "active" ? "schedule"
    : trip.eta?.status === "live" || trip.eta?.status === "aging"
      ? trip.eta.source === "mapbox-traffic" ? "live traffic" : "live GPS pace"
      : trip.eta?.status === "stale" ? "paused, location stale"
        : trip.eta?.status === "off-route" ? "paused, bus off route" : "calculating";
  return <>
    <div className="d-sec"><h3>Stops</h3><span>ETA: {source}</span></div>
    <ol className="eta" style={{ "--c": color } as CSSProperties}>{trip.stops.map((stop, index) => {
      const last = index === trip.stops.length - 1;
      const done = !!stop.departedAt || (last && !!stop.arrivedAt);
      const eta = stopEta(trip, stop.id);
      const minutes = eta ? Math.max(0, Math.round((Date.parse(eta) - now) / 60_000)) : null;
      const control = !readOnly && index === current && (!stop.arrivedAt || !last);
      const right = stop.arrivedAt
        ? <>{time(stop.arrivedAt)}{stop.arrivalMethod && <span className={`mt ${stop.arrivalMethod}`}>{stop.arrivalMethod === "automatic" ? "AUTO" : stop.arrivalMethod === "override" ? "TAPPED, GPS DISAGREED" : "TAPPED"}</span>}</>
        : eta ? `ETA ${time(eta)} · ${minutes} min`
          : trip.status === "planned" ? "Planned" : "";
      return <li key={stop.id} className={done ? "done" : index === current ? "cur" : ""}>
        <i /><span>{stop.position}. {stop.label}</span><em>{right}</em>
        {control && <button type="button" className="btn sm" disabled={actions.busy}
          onClick={() => actions.request(trip, stop.arrivedAt ? "depart" : "arrive", stop.id)}>
          {stop.arrivedAt ? "Record departure" : "Record arrival"}
        </button>}
      </li>;
    })}</ol>
  </>;
}

/** Full trip detail: the desktop right pane, and the phone sheet. */
export function TripDetail({ row, trip, staff, drivers, buses, routes, now, actions, editable, onOpenTrip, onChanged, onEdited, toast, riders }: {
  row: BusRow; trip: BoardTrip; staff: TripStaff[]; drivers: TripDriver[]; now: number; actions: TripActions;
  editable: boolean; onOpenTrip: (id: string) => void; onChanged: () => void;
  toast: (text: string) => void; riders: { aboard: number; total: number } | null;
  buses: Bus[]; routes: Route[]; onEdited: (departureAt: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [trip.id, trip.status]);
  const late = timing(trip, now);
  const featured = row.trip?.id === trip.id;
  const alerts = featured ? row.alerts.filter((alert) => alert.kind !== "late" && alert.kind !== "due") : [];
  const phone = presence(trip, now);
  const others = row.trips.filter((item) => item.id !== trip.id);
  const gpsText = trip.status !== "active" ? "Starts with trip"
    : trip.location ? age(trip.location.observedAt, now) : "None yet";

  return <>
    <p className="eyebrow">Bus</p>
    <h2 className="d-title"><Swatch color={row.color} />{row.bus.label}<span className="per">{trip.servicePeriod}</span></h2>
    <div className="d-status"><TripPill status={trip.status} /><span>{trip.routeName} · departs {time(trip.departureAt)}</span></div>
    {(late || alerts.length > 0) && <div className="d-alerts">
      {late && <div className="alert alert-high"><b>{late.kind === "due" ? "DUE NOW" : "TRIP OVERDUE"}</b>
        <span>Scheduled {time(trip.departureAt)}{late.kind === "overdue" ? ` · ${late.minutes} min late` : ""}</span></div>}
      {alerts.map((alert) => <div key={alert.text} className={`alert ${alert.sev === "high" ? "alert-high" : ""}`}>
        <b>{alert.sev === "high" ? "ATTENTION" : "HEADS UP"}</b><span>{alert.text}</span></div>)}
    </div>}
    {/* Trip controls first, so they never sit below the fold. */}
    {(trip.status === "planned" || trip.status === "active") && !editing && <div className="acts trip-controls" aria-label="Trip controls">
      {editable && trip.status === "planned" && <button type="button" className="btn btn-primary" disabled={actions.busy || !trip.assignedStaff}
        title={trip.assignedStaff ? undefined : "Pick a lead counselor first"}
        onClick={() => actions.request(trip, "start")}>Start trip</button>}
      {editable && trip.status === "active" && <button type="button" className="btn btn-primary" disabled={actions.busy || !canComplete(trip)}
        title={canComplete(trip) ? undefined : "Available at the last stop"}
        onClick={() => actions.request(trip, "complete")}>Complete trip</button>}
      {trip.status === "planned" && <button type="button" className="btn" onClick={() => setEditing(true)}>Edit trip</button>}
      <button type="button" className="btn btn-danger" disabled={actions.busy}
        onClick={() => actions.request(trip, "cancel")}>Cancel trip</button>
    </div>}
    {trip.status === "planned" && editing && <EditTripForm key={trip.id} trip={trip} buses={buses} routes={routes}
      onClose={() => setEditing(false)} onSaved={(departureAt) => { setEditing(false); toast("Trip updated."); onEdited(departureAt); }} />}
    <ConfirmFor trip={trip} actions={actions} />
    {!editable && (trip.status === "planned" || trip.status === "active") && <p className="hint">Start and stop controls are available on today&rsquo;s board.</p>}
    <dl className="d-grid">
      <div className="wide"><dt>Crew</dt><dd><CrewPills lead={trip.assignedStaff} counselors={trip.counselors} driver={trip.driver} />
        {(trip.assignedStaff?.phone || trip.driver?.phone) && <span className="d-calls">
          {trip.assignedStaff?.phone && <a className="btn sm" href={`tel:${trip.assignedStaff.phone.replace(/[^\d+]/g, "")}`}>Call lead · {trip.assignedStaff.phone}</a>}
          {trip.driver?.phone && <a className="btn sm" href={`tel:${trip.driver.phone.replace(/[^\d+]/g, "")}`}>Call driver · {trip.driver.phone}</a>}
        </span>}</dd></div>
      <div><dt>Phone</dt><dd className={phone ? phone.ok ? "ok" : "bad" : ""}>{phone ? phone.text.replace(/^Phone: /, "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "None"}</dd></div>
      <div><dt>GPS</dt><dd className={trip.status === "active" && !trip.location ? "bad" : ""}>{gpsText}</dd></div>
      {riders
        ? <div><dt>Riders</dt><dd>{trip.status === "planned" ? `${riders.total} expected` : `${riders.aboard} of ${riders.total} aboard`}</dd></div>
        : <div><dt>Progress</dt><dd>{stopsDone(trip)} of {trip.stops.length} stops</dd></div>}
    </dl>
    <p className="tk">{trackingText(trip, now)}</p>
    {(trip.status === "planned" || trip.status === "active") &&
      <CrewAssign trip={trip} staff={staff} drivers={drivers} onSaved={onChanged} toast={toast} />}
    {others.length > 0 && <div className="dblock"><h3>Other trips for {row.bus.label}</h3>
      <div className="acts" style={{ margin: 0 }}>{others.map((other) => <button key={other.id} type="button" className="btn sm"
        onClick={() => onOpenTrip(other.id)}>{other.routeName} · {time(other.departureAt)}</button>)}</div>
    </div>}
    <StopsList trip={trip} color={row.color} actions={actions} readOnly={!editable} now={now} />
    {trip.status !== "planned" && <GpsLog tripId={trip.id} />}
  </>;
}
