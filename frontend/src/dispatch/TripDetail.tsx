import { useEffect, useState, type CSSProperties } from "react";
import {
  assignTripStaffSchema, dispatchGpsAuditResponseSchema,
  type BoardTrip, type DispatchGpsAuditEntry, type TripStaff
} from "@bussin/shared";
import { getJson, message, send } from "../ops/api";
import { duration, time, timeWithSeconds } from "../ops/format";
import {
  canComplete, currentStopIndex, etaText, presence, stopEta, stopsDone, timing, trackingText,
  type BusRow
} from "../ops/fleetModel";
import type { TripActions } from "../ops/useTripActions";
import { Confirm, Swatch } from "../ops/ui";

export function TripPill({ status }: { status: BoardTrip["status"] }) {
  return <span className={`st st-t-${status}`}>{status.toUpperCase()}</span>;
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
  return <Confirm danger text={pending.type === "cancel" ? "Cancel this trip? It cannot be restarted." : "Complete this trip?"}
    yes={`Yes, ${pending.type}`} onYes={actions.confirm} onNo={actions.dismiss} busy={actions.busy} />;
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
      toast(choice ? "Staff assigned." : "Staff removed from this trip.");
      onSaved();
    } catch (cause) {
      toast(message(cause, "Could not save staff assignment."));
    } finally {
      setSaving(false);
    }
  }

  return <div className="ctl-row dblock">
    <label htmlFor={`staff-${trip.id}`}>Assigned staff</label>
    <div style={{ display: "flex", gap: 8 }}>
      <select id={`staff-${trip.id}`} value={choice} disabled={saving} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Unassigned</option>
        {staff.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
      </select>
      <button type="button" className="btn" disabled={saving || choice === current} onClick={() => void save()}>
        {saving ? "Saving…" : "Save staff"}
      </button>
    </div>
    {!trip.assignedStaff && <span className="hint">Assign staff before starting this trip.</span>}
  </div>;
}

function GpsLog({ tripId }: { tripId: string }) {
  const [entries, setEntries] = useState<DispatchGpsAuditEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = () => getJson(`/api/dispatch/trips/${tripId}/gps-audit`, dispatchGpsAuditResponseSchema, controller.signal)
      .then((data) => { setEntries(data.entries); setError(""); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause, "Could not load GPS capture log.")); });
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [tripId]);

  const count = entries.filter((entry) => entry.kind === "sample").length;
  return <div className="dblock">
    <div className="d-sec" style={{ margin: "0 0 8px" }}><h3>GPS capture log</h3><span>{count} captured</span></div>
    <p className="hint" style={{ margin: "0 0 8px" }}>What Dispatch actually received from the staff phone. Newest first.</p>
    {error ? <p className="err" role="alert">{error}</p> : entries.length === 0 ? <p className="hint">No GPS captures yet.</p> :
      <ol className="gl">{entries.map((entry) => entry.kind === "sample"
        ? <li key={entry.id}><time>{timeWithSeconds(entry.observedAt)}</time><strong>GPS CAPTURE</strong>
          <span>±{Math.round(entry.accuracyM)} m · {entry.latitude.toFixed(6)}, {entry.longitude.toFixed(6)} · {entry.speedMps === null ? "speed —" : `${(entry.speedMps * 2.23694).toFixed(1)} mph`}</span></li>
        : entry.kind === "journey"
          ? <li key={entry.id} className="j"><time>{timeWithSeconds(entry.occurredAt)}</time>
            <strong>{entry.action === "arrived_stop" ? "AUTO ARRIVED" : "AUTO DEPARTED"}</strong><span>{entry.stopLabel}</span></li>
          : entry.kind === "correction"
            ? <li key={entry.id} className="g"><time>{timeWithSeconds(entry.occurredAt)}</time>
              <strong>ARRIVAL UNDONE</strong><span>{entry.stopLabel}</span></li>
            : <li key={entry.id} className="g"><time>{timeWithSeconds(entry.resumedAt)}</time>
              <strong>GPS RESUMED</strong><span>No accepted captures for {duration(entry.durationSeconds)}</span></li>)}
      </ol>}
  </div>;
}

export function StopsList({ trip, color, actions, readOnly }: {
  trip: BoardTrip; color: string; actions: TripActions; readOnly?: boolean;
}) {
  const current = trip.status === "active" ? currentStopIndex(trip) : -1;
  return <>
    <div className="d-sec"><h3>Stops in route order</h3><span>{stopsDone(trip)} of {trip.stops.length} done</span></div>
    <StopMiniLine trip={trip} color={color} />
    <div style={{ height: 14 }} />
    <ol className="tl">{trip.stops.map((stop, index) => {
      const last = index === trip.stops.length - 1;
      const eta = stopEta(trip, stop.id);
      const control = !readOnly && index === current && (!stop.arrivedAt || !last);
      return <li key={stop.id} className={index === current ? "cur" : ""}>
        <strong>{stop.position}. {stop.label}</strong>
        <span>{stop.arrivedAt ? `Arrived ${time(stop.arrivedAt)}` : "Arrival not recorded"}</span>
        {eta && !stop.arrivedAt && <span><b>ETA {time(eta)}</b></span>}
        <span>{last ? "Final destination" : stop.departedAt ? `Departed ${time(stop.departedAt)}` : "Departure not recorded"}</span>
        {control && <button type="button" className="btn" disabled={actions.busy}
          onClick={() => actions.request(trip, stop.arrivedAt ? "depart" : "arrive", stop.id)}>
          {stop.arrivedAt ? "Record departure" : "Record arrival"}
        </button>}
      </li>;
    })}</ol>
  </>;
}

/** Full trip detail: shared by the desktop right pane, the drawer and the phone sheet. */
export function TripDetail({ row, trip, staff, now, actions, editable, onOpenTrip, onChanged, toast, withGps = true }: {
  row: BusRow; trip: BoardTrip; staff: TripStaff[]; now: number; actions: TripActions;
  editable: boolean; onOpenTrip: (id: string) => void; onChanged: () => void;
  toast: (text: string) => void; withGps?: boolean;
}) {
  const late = timing(trip, now);
  const featured = row.trip?.id === trip.id;
  const alerts = featured ? row.alerts.filter((alert) => alert.kind !== "late" && alert.kind !== "due") : [];
  const eta = etaText(trip);
  const phone = presence(trip, now);
  const others = row.trips.filter((item) => item.id !== trip.id);

  return <>
    <p className="eyebrow">BUS</p>
    <h2 className="d-title"><Swatch color={row.color} />{row.bus.label}
      <span className="per" style={{ fontSize: 14 }}>{trip.servicePeriod}</span></h2>
    <div className="d-status"><TripPill status={trip.status} /><span>{trip.routeName} · {time(trip.departureAt)}</span></div>
    {late && <div className="d-alerts"><div className="alert alert-high">
      <b>{late.kind === "due" ? "DUE NOW" : "TRIP OVERDUE"}</b>
      <span>Scheduled {time(trip.departureAt)}{late.kind === "overdue" ? ` · ${late.minutes} min late` : ""}</span>
    </div></div>}
    {alerts.length > 0 && <div className="d-alerts">{alerts.map((alert) =>
      <div key={alert.text} className={`alert alert-${alert.sev}`}>
        <b>{alert.sev === "high" ? "ATTENTION" : "HEADS UP"}</b><span>{alert.text}</span></div>)}</div>}
    <div className="dblock">
      <p className="tk">{trackingText(trip, now)}</p>
      {eta && <p className="tk"><b>{eta}</b></p>}
    </div>
    {trip.status === "planned" && editable
      ? <StaffAssign trip={trip} staff={staff} onSaved={onChanged} toast={toast} />
      : <p className="tk dblock">Staff: <b>{trip.assignedStaff?.displayName ?? "Not recorded"}</b></p>}
    {phone && <p className={`pres ${phone.ok ? "ok" : "no"}`}>{phone.text}</p>}
    {editable ? <>
      {(trip.status === "planned" || trip.status === "active") && <div className="acts" aria-label="Trip controls">
        {trip.status === "planned" && <>
          <button type="button" className="btn btn-primary" disabled={actions.busy || !trip.assignedStaff}
            onClick={() => actions.request(trip, "start")}>Start trip</button>
          <button type="button" className="btn btn-danger" disabled={actions.busy}
            onClick={() => actions.request(trip, "cancel")}>Cancel trip</button>
        </>}
        {trip.status === "active" && <>
          <button type="button" className="btn btn-danger" disabled={actions.busy}
            onClick={() => actions.request(trip, "cancel")}>Cancel trip</button>
          <button type="button" className="btn btn-primary" disabled={actions.busy || !canComplete(trip)}
            onClick={() => actions.request(trip, "complete")}>Complete trip</button>
        </>}
      </div>}
      <ConfirmFor trip={trip} actions={actions} />
    </> : <p className="hint">Trip controls are available on today&rsquo;s board only.</p>}
    {others.length > 0 && <div className="dblock"><h3>Other trips for {row.bus.label}</h3>
      {others.map((other) => <button key={other.id} type="button" className="btn" style={{ margin: "0 6px 6px 0" }}
        onClick={() => onOpenTrip(other.id)}>{other.routeName} · {time(other.departureAt)}</button>)}
    </div>}
    <StopsList trip={trip} color={row.color} actions={actions} readOnly={!editable} />
    {withGps && trip.status !== "planned" && <GpsLog tripId={trip.id} />}
  </>;
}
