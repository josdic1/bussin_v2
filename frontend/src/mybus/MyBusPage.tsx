import { useMemo, useState, type CSSProperties } from "react";
import { age, localDate, time, routeWithPeriod } from "../ops/format";
import {
  currentStopIndex, etaText, fleetRows, gpsStale, nextAction, presence, stopsDone
} from "../ops/fleetModel";
import { useOps } from "../ops/OpsShell";
import { ErrorNote, NoMatch } from "../ops/ui";
import { useBoard, useNow } from "../ops/useBoard";
import { useTripActions } from "../ops/useTripActions";
import { ConfirmFor } from "../dispatch/TripDetail";

function readBus() {
  try { return window.localStorage.getItem("bussin.myBus"); } catch { return null; }
}
function saveBus(id: string) {
  try { window.localStorage.setItem("bussin.myBus", id); } catch { /* storage unavailable */ }
}

export function MyBusPage() {
  const { toast } = useOps();
  const board = useBoard(localDate(new Date()));
  const now = useNow();
  const actions = useTripActions(board.reload, toast);
  const [busId, setBusId] = useState<string | null>(readBus);

  const rows = useMemo(() => fleetRows(board.buses, board.trips, now).filter((row) => row.trips.length),
    [board.buses, board.trips, now]);
  const row = rows.find((item) => item.bus.id === busId) ?? rows[0];

  if (!row) {
    return <div className="drv">
      <p className="eyebrow">DRIVER / MY BUS</p><h1 className="sh1">My Bus</h1>
      <ErrorNote text={board.error} />
      <NoMatch>{board.loading ? "Loading buses…" : "No bus has a trip today."}</NoMatch>
    </div>;
  }

  const trip = row.trip;
  const next = trip ? nextAction(trip) : null;
  const index = trip?.status === "active" ? currentStopIndex(trip) : -1;
  const stop = index >= 0 && trip ? trip.stops[index] : null;
  const phone = trip ? presence(trip, now) : null;
  const later = trip ? row.trips.filter((item) => item.id !== trip.id && item.status !== "cancelled") : [];
  const eta = trip ? etaText(trip) : null;
  const gpsClass = row.status === "GPS STALE" ? "stale" : row.latestGps && row.status === "IN SERVICE" ? "live" : "none";

  let body;
  if (!trip) {
    body = <div className="dcard"><p className="dbig">No trip for this bus today.</p></div>;
  } else if (trip.status === "active") {
    const label = next?.kind === "arrive" ? `Arrived at ${next.stopLabel}` : next?.kind === "depart" ? `Leaving ${next.stopLabel}` : next?.kind === "complete" ? "Finish trip" : "";
    body = <div className="dcard">
      <span className="ov">NEXT STOP</span>
      <p className="dbig">{stop?.label ?? "—"}</p>
      <p className="dsub2">{eta?.replace(/^.*?· (?=ETA)/, "") ?? "ETA calculating"}</p>
      {next && label && <button type="button" className="bigbtn" disabled={actions.busy} onClick={() =>
        actions.request(trip, next.kind === "complete" ? "complete" : next.kind === "arrive" ? "arrive" : "depart",
          "stopId" in next ? next.stopId : undefined)}>{label}</button>}
      {stop?.arrivedAt && !stop.departedAt && <button type="button" className="bigbtn out slim" disabled={actions.busy}
        onClick={() => actions.request(trip, "undo_arrival", stop.id)}>Not here yet, undo arrival</button>}
      <ConfirmFor trip={trip} actions={actions} />
    </div>;
  } else if (trip.status === "planned") {
    body = <div className="dcard">
      <span className="ov">NEXT TRIP</span>
      <p className="dbig">Leaves at {time(trip.departureAt)}</p>
      <p className="dsub2">{trip.routeName}</p>
      {trip.assignedStaff
        ? <button type="button" className="bigbtn" disabled={actions.busy} onClick={() => actions.request(trip, "start")}>Start trip</button>
        : <p className="bad">No driver is assigned. Ask dispatch to assign one.</p>}
      <ConfirmFor trip={trip} actions={actions} />
    </div>;
  } else {
    body = <div className="dcard"><p className="dbig">{trip.status === "completed" ? "Trip finished." : "Trip cancelled."}</p>
      <p className="dsub2">{routeWithPeriod(trip.routeName, trip.servicePeriod)}</p></div>;
  }

  return <div className="drv">
    <p className="eyebrow">DRIVER / MY BUS</p>
    <h1 className="sh1">{row.bus.label}</h1>
    <p className="desc" style={{ margin: "6px 0 4px" }}>{trip ? `${routeWithPeriod(trip.routeName, trip.servicePeriod)} · ${trip.assignedStaff?.displayName ?? "No driver"}` : ""}</p>
    <ErrorNote text={board.error} />
    <div className="chips" role="group" aria-label="Choose your bus">{rows.map((item) => <button key={item.bus.id} type="button"
      className={`chip${item.bus.id === row.bus.id ? " on" : ""}`} aria-pressed={item.bus.id === row.bus.id}
      onClick={() => { setBusId(item.bus.id); saveBus(item.bus.id); }}>{item.bus.label}</button>)}</div>
    <div className="drow">
      <span className={`gps ${gpsClass}`}><i />{age(row.latestGps, now)}</span>
      {phone && <span className={`pres ${phone.ok ? "ok" : "no"}`}>{phone.ok ? "Phone online" : "Phone not reporting"}</span>}
    </div>
    {trip && gpsStale(trip, now) && <div className="alert alert-high"><b>GPS</b>
      <span>Dispatch is not receiving this bus&rsquo;s location. Keep the staff app open on the driver&rsquo;s phone.</span></div>}
    {body}
    {trip && trip.status !== "cancelled" && <>
      <div className="d-sec"><h3>Stops</h3><span>{stopsDone(trip)} of {trip.stops.length} done</span></div>
      <ol className="d-stops">{trip.stops.map((item, position) => {
        const done = !!item.departedAt || (position === trip.stops.length - 1 && !!item.arrivedAt);
        const cls = done ? "done" : position === index ? "cur" : "";
        return <li key={item.id} className={cls}><i style={{ "--c": row.color } as CSSProperties} /><span>{item.label}</span>
          <em>{item.arrivedAt ? `Arrived ${time(item.arrivedAt)}` : cls === "cur" ? "Next" : ""}</em></li>;
      })}</ol>
    </>}
    {later.length > 0 && <><div className="d-sec"><h3>Other trips today</h3></div>
      {later.map((item) => <div key={item.id} className="d-trip"><div><strong>{item.routeName}</strong>
        <span>{item.servicePeriod} · {time(item.departureAt)}</span></div><span className={`ts ts-${item.status}`}>{item.status}</span></div>)}</>}
  </div>;
}
