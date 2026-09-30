import { useEffect, useState, type CSSProperties } from "react";
import {
  assignTripStaffSchema, dispatchGpsAuditResponseSchema,
  type BoardTrip, type DispatchGpsAuditEntry, type TripStaff
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { age, duration, time, timeWithSeconds } from "../ops/format";
import {
  canComplete, currentStopIndex, presence, stopEta, stopsDone, timing, trackingText,
  type BusRow
} from "../ops/fleetModel";
import type { TripActions } from "../ops/useTripActions";
import { Confirm, Swatch } from "../ops/ui";

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

function StaffAssign({ trip, staff, onSaved, toast }: {
  trip: BoardTrip; staff: TripStaff[]; onSaved: () => void; toast: (text: string) => void;
}) {
  const current = trip.assignedStaff?.id ?? "";
  const [choice, setChoice] = useState(current);
  const [saving, setSaving] = useState(false);
  useEffect(() => setChoice(current), [trip.id, current]);

  async function save() {
    const parsed = assignTripStaffSchema.safeParse({ memberId: choice || null });
    if (!parsed.success) return;
    setSaving(true);
    try {
      await send("PUT", `/api/dispatch/trips/${trip.id}/staff`, parsed.data, "Could not save staff assignment.");
      const person = staff.find((item) => item.id === choice);
      toast(person ? `${person.displayName} assigned to ${trip.busLabel}.` : "Staff removed from this trip.");
      onSaved();
    } catch (cause) {
      toast(message(cause, "Could not save staff assignment."));
    } finally {
      setSaving(false);
    }
  }

  return <div className="dblock">
    <label className="lt" htmlFor={`staff-${trip.id}`}>Assigned staff</label>
    <div className="assign" style={{ marginTop: 6 }}>
      <select id={`staff-${trip.id}`} value={choice} disabled={saving} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Unassigned</option>
        {staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
      </select>
      <button type="button" className="btn btn-primary" disabled={saving || choice === current} onClick={() => void save()}>
        {saving ? "Saving…" : "Assign"}
      </button>
    </div>
    {!trip.assignedStaff && <span className="hint">Assign staff before starting this trip.</span>}
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
        ? <>{time(stop.arrivedAt)}{stop.arrivalMethod && <span className={`mt ${stop.arrivalMethod}`}>{stop.arrivalMethod === "automatic" ? "AUTO" : "MANUAL"}</span>}</>
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
export function TripDetail({ row, trip, staff, now, actions, editable, onOpenTrip, onChanged, toast, riders }: {
  row: BusRow; trip: BoardTrip; staff: TripStaff[]; now: number; actions: TripActions;
  editable: boolean; onOpenTrip: (id: string) => void; onChanged: () => void;
  toast: (text: string) => void; riders: { aboard: number; total: number } | null;
}) {
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
    <dl className="d-grid">
      <div><dt>Driver</dt><dd>{trip.assignedStaff?.displayName ?? "Unassigned"}</dd></div>
      <div><dt>Phone</dt><dd className={phone ? phone.ok ? "ok" : "bad" : ""}>{phone ? phone.text.replace(/^Phone: /, "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "None"}</dd></div>
      <div><dt>GPS</dt><dd className={trip.status === "active" && !trip.location ? "bad" : ""}>{gpsText}</dd></div>
      {riders
        ? <div><dt>Riders</dt><dd>{trip.status === "planned" ? `${riders.total} expected` : `${riders.aboard} of ${riders.total} aboard`}</dd></div>
        : <div><dt>Progress</dt><dd>{stopsDone(trip)} of {trip.stops.length} stops</dd></div>}
    </dl>
    <p className="tk">{trackingText(trip, now)}</p>
    {trip.status === "planned" && editable && <StaffAssign trip={trip} staff={staff} onSaved={onChanged} toast={toast} />}
    {editable ? <>
      {(trip.status === "planned" || trip.status === "active") && <div className="acts" aria-label="Trip controls">
        {trip.status === "planned" && <button type="button" className="btn btn-primary" disabled={actions.busy || !trip.assignedStaff}
          onClick={() => actions.request(trip, "start")}>Start trip</button>}
        {trip.status === "active" && <button type="button" className="btn btn-primary" disabled={actions.busy || !canComplete(trip)}
          title={canComplete(trip) ? undefined : "Available at the last stop"}
          onClick={() => actions.request(trip, "complete")}>Complete trip</button>}
        <button type="button" className="btn btn-danger" disabled={actions.busy}
          onClick={() => actions.request(trip, "cancel")}>Cancel trip</button>
      </div>}
      <ConfirmFor trip={trip} actions={actions} />
    </> : <p className="hint">Trip controls are available on today&rsquo;s board only.</p>}
    {others.length > 0 && <div className="dblock"><h3>Other trips for {row.bus.label}</h3>
      <div className="acts" style={{ margin: 0 }}>{others.map((other) => <button key={other.id} type="button" className="btn sm"
        onClick={() => onOpenTrip(other.id)}>{other.routeName} · {time(other.departureAt)}</button>)}</div>
    </div>}
    <StopsList trip={trip} color={row.color} actions={actions} readOnly={!editable} now={now} />
    {trip.status !== "planned" && <GpsLog tripId={trip.id} />}
  </>;
}
