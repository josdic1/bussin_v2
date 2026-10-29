import { lazy, Suspense, useState, type CSSProperties } from "react";
import type { BoardTrip } from "@bussin/shared";
import { age, MIN, plural, routeWithPeriod, time } from "../ops/format";
import { busNumber, gpsFresh, nextEta } from "../ops/fleetModel";

/*
 * The live board: only what's moving now and what leaves next. Finished trips live in Transit.
 * Two plain tables. "On the road" has a slim route strip per bus: its stops as dots, the ones
 * it has passed filled in, and a marker where the bus is. No map to pan or zoom.
 */

type Riders = { aboard: number; total: number } | null;

/** "4 min", "1 h 20 min" */
function minutes(ms: number) {
  const total = Math.max(0, Math.round(ms / MIN));
  return total < 90 ? `${total} min` : `${Math.floor(total / 60)} h${total % 60 ? ` ${total % 60} min` : ""}`;
}

function stopDone(trip: BoardTrip, index: number) {
  const stop = trip.stops[index]!;
  return index === trip.stops.length - 1 ? !!stop.arrivedAt : !!stop.departedAt;
}

/** Where the bus is on its line: at a stop (index) or between two (index + 0.5). */
function busPosition(trip: BoardTrip): number {
  const at = trip.stops.findIndex((stop) => stop.arrivedAt && !stop.departedAt);
  if (at >= 0) return at;
  const next = trip.stops.findIndex((_, index) => !stopDone(trip, index));
  if (next <= 0) return 0;
  return next - 0.5;
}

const DispatchMap = lazy(async () => ({ default: (await import("./DispatchMap")).DispatchMap }));

/** One bus's route as a slim strip of dots, with a marker over where the bus is. */
function Strip({ trip, color }: { trip: BoardTrip; color: string }) {
  const count = trip.stops.length;
  const spot = busPosition(trip);
  const pct = (index: number) => count > 1 ? `${(index / (count - 1)) * 100}%` : "50%";
  const done = trip.stops.filter((_, index) => stopDone(trip, index)).length;
  return <div className="lb-strip" style={{ "--c": color } as CSSProperties} role="img" aria-label={`${done} of ${count} stops done`}>
    <i className="lb-strip-track" /><i className="lb-strip-done" style={{ width: pct(spot) }} />
    {trip.stops.map((stop, index) => <b key={stop.id} className={stopDone(trip, index) ? "f" : ""} style={{ left: pct(index) }} title={stop.label} />)}
    <u style={{ left: pct(spot) }} />
  </div>;
}

export function LiveBoard({ trips, colorOf, now, isToday, riders, onOpen, onStart, onTransit }: {
  trips: BoardTrip[]; colorOf: (busId: string) => string; now: number; isToday: boolean;
  riders: (tripId: string) => Riders; onOpen: (tripId: string) => void; onStart: (trip: BoardTrip) => void; onTransit: () => void;
}) {
  const running = trips.filter((trip) => trip.status === "active")
    .sort((a, b) => a.busLabel.localeCompare(b.busLabel, undefined, { numeric: true }));
  const upcoming = trips.filter((trip) => trip.status === "planned")
    .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));
  const finished = trips.filter((trip) => trip.status === "completed" || trip.status === "cancelled").length;
  // Pointing at a row lights that bus up on the map.
  const [hover, setHover] = useState<string | null>(null);
  const key = (open: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") open(); };
  const bus = (trip: BoardTrip) => <span className="lb-bus-cell">
    <span className="av" style={{ "--c": colorOf(trip.busId), "--s": "24px" } as CSSProperties}>{busNumber(trip.busLabel)}</span>{trip.busLabel}</span>;

  return <div className="lb">
    {isToday && <>
      <div className="sec-h"><h2>On the road · {running.length}</h2><span>Click a row for the full trip</span></div>
      {running.length > 0 && <div className="lb-map"><Suspense fallback={<div className="mapfill" />}>
        <DispatchMap trips={running} colorForBus={colorOf} selectedTripId={hover} onSelect={onOpen} now={now} fixedAll />
      </Suspense></div>}
      {running.length ? <div className="lb-table"><table className="tbl">
        <thead><tr><th>Bus</th><th>Route</th><th>Where</th><th>Now</th><th>ETA</th><th>Kids</th><th>GPS</th><th>Lead</th></tr></thead>
        <tbody>{running.map((trip) => {
          const here = trip.stops.find((stop) => stop.arrivedAt && !stop.departedAt);
          const next = trip.stops.find((_, index) => !stopDone(trip, index));
          const eta = nextEta(trip);
          const fresh = gpsFresh(trip, now);
          const count = riders(trip.id);
          const open = () => onOpen(trip.id);
          return <tr key={trip.id} data-ov="" tabIndex={0} onClick={open} onKeyDown={key(open)}
            onMouseEnter={() => setHover(trip.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(trip.id)} onBlur={() => setHover(null)}>
            <td>{bus(trip)}</td>
            <td>{routeWithPeriod(trip.routeName, trip.servicePeriod)}</td>
            <td><Strip trip={trip} color={colorOf(trip.busId)} /></td>
            <td>{here ? `At ${here.label}, ${minutes(now - Date.parse(here.arrivedAt!))}` : next ? `Next: ${next.label}` : "At the last stop"}</td>
            <td>{eta ? time(eta.etaAt) : <span className="dim">unknown</span>}</td>
            <td>{count ? count.aboard : <span className="dim">—</span>}</td>
            <td className={fresh ? "" : "bad"}>{trip.location ? age(trip.location.observedAt, now) : "none"}
              {trip.location && <a className="lb-where" target="_blank" rel="noreferrer" title="Open where the bus is in Google Maps"
                onClick={(event) => event.stopPropagation()}
                href={`https://www.google.com/maps?q=${trip.location.latitude},${trip.location.longitude}`}>map</a>}</td>
            <td>{trip.assignedStaff?.displayName ?? <span className="bad">None</span>}</td>
          </tr>;
        })}</tbody></table></div>
        : <p className="lb-empty">No bus is running right now.</p>}
    </>}
    <div className="sec-h"><h2>{isToday ? "Coming up" : "Planned for tomorrow"} · {upcoming.length}</h2><span>Departure order</span></div>
    {upcoming.length ? <div className="lb-table"><table className="tbl">
      <thead><tr><th>Leaves</th><th>Bus</th><th>Route</th><th>Lead</th><th>Driver</th><th>Status</th><th /></tr></thead>
      <tbody>{upcoming.map((trip) => {
        const until = Math.round((Date.parse(trip.departureAt) - now) / MIN);
        const late = isToday && until < -1;
        const due = isToday && until <= 5;
        const open = () => onOpen(trip.id);
        return <tr key={trip.id} data-ov="" tabIndex={0} className={late ? "late" : ""} onClick={open} onKeyDown={key(open)}>
          <td><b>{time(trip.departureAt)}</b></td>
          <td>{bus(trip)}</td>
          <td>{routeWithPeriod(trip.routeName, trip.servicePeriod)}</td>
          <td>{trip.assignedStaff?.displayName ?? <span className="bad">None</span>}</td>
          <td>{trip.driver?.name ?? <span className="bad">None</span>}</td>
          <td className={late ? "bad" : due ? "warn" : "dim"}>{!isToday ? "Tomorrow" : late ? `${-until} min late` : until <= 1 ? "Due now" : `in ${minutes(until * MIN)}`}</td>
          <td className="lb-act">{due && trip.assignedStaff
            ? <button type="button" className="lb-link" onClick={(event) => { event.stopPropagation(); onStart(trip); }}>Start</button>
            : !trip.assignedStaff ? <button type="button" className="lb-link" onClick={(event) => { event.stopPropagation(); open(); }}>Assign crew</button> : null}</td>
        </tr>;
      })}</tbody></table></div>
      : <p className="lb-empty">{isToday ? "Nothing else planned today." : "Nothing planned yet. Use + Plan trip."}</p>}
    {isToday && finished > 0 && <p className="lb-done-note">{finished} {plural(finished, "trip", "trips")} finished today.{" "}
      <button type="button" onClick={onTransit}>See them in Transit</button></p>}
  </div>;
}
