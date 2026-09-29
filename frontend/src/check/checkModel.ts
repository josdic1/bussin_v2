import type { CheckRider, CheckTrip } from "@bussin/shared";
import { time } from "../ops/format";

export type CheckAlertKey = "stale" | "unconf" | "missed" | "final" | "after" | "sweep" | "noshow" | "nomon";
export type CheckAlert = { sev: "high" | "med"; key: CheckAlertKey; text: string; short: string; rider?: CheckRider };

const PRESENCE_STALE_MS = 60_000;

export function stopIndex(trip: CheckTrip, stopId: string) {
  return trip.stops.findIndex((stop) => stop.id === stopId);
}

export function stopLabel(trip: CheckTrip, stopId: string) {
  return trip.stops.find((stop) => stop.id === stopId)?.label ?? "their stop";
}

/** A stop is behind the bus once it has departed it (or reached it, for the final stop). */
export function stopPassed(trip: CheckTrip, stopId: string) {
  const index = stopIndex(trip, stopId);
  const stop = trip.stops[index];
  if (!stop) return false;
  return index === trip.stops.length - 1 ? !!stop.arrivedAt : !!stop.departedAt;
}

export function counts(trip: CheckTrip) {
  const result = { total: 0, aboard: 0, dropped: 0, expected: 0, no_show: 0, not_riding: 0 };
  for (const rider of trip.riders) {
    if (rider.state !== "not_riding") result.total += 1;
    result[rider.state] += 1;
  }
  return result;
}

/** The number that matters: AM counts who got on, PM counts who is still on. */
export function headcount(trip: CheckTrip) {
  const c = counts(trip);
  return trip.servicePeriod === "AM"
    ? { n: c.aboard + c.dropped, of: c.total - c.no_show, label: "boarded" }
    : { n: c.aboard, of: c.total, label: "aboard" };
}

/** PM: still marked aboard after their drop-off stop was passed. */
export function unconfirmed(trip: CheckTrip, rider: CheckRider) {
  return trip.servicePeriod === "PM" && rider.state === "aboard" && !rider.handled && stopPassed(trip, rider.stopId) &&
    rider.stopId !== trip.stops.at(-1)?.id;
}

/** AM: the bus left their pick-up stop and nobody checked them on or off. */
export function missed(trip: CheckTrip, rider: CheckRider) {
  return trip.servicePeriod === "AM" && trip.status !== "planned" && rider.state === "expected" && stopPassed(trip, rider.stopId);
}

export function alerts(trip: CheckTrip, now: number): CheckAlert[] {
  if (trip.status === "cancelled") return [];
  const out: CheckAlert[] = [];
  const c = counts(trip);
  const finalArrived = !!trip.stops.at(-1)?.arrivedAt;

  if (trip.status === "active" && trip.assignedStaff &&
      (!trip.staffLastSeenAt || now - Date.parse(trip.staffLastSeenAt) > PRESENCE_STALE_MS)) {
    out.push({ sev: "high", key: "stale", short: "Staff phone offline",
      text: trip.staffLastSeenAt ? `Staff phone offline since ${time(trip.staffLastSeenAt)}.` : "Staff phone has not reported." });
  }
  for (const rider of trip.riders) {
    if (unconfirmed(trip, rider)) {
      out.push({ sev: "high", key: "unconf", rider, short: "Not dropped off",
        text: `${rider.givenName} is still marked aboard, but ${stopLabel(trip, rider.stopId)} was passed.` });
    }
  }
  if (trip.status === "active" && finalArrived && c.aboard > 0) {
    out.push({ sev: "high", key: "final", short: `${c.aboard} still aboard`,
      text: `${c.aboard} ${c.aboard === 1 ? "child" : "children"} still aboard at ${trip.stops.at(-1)?.label ?? "the last stop"}.` });
  }
  if (trip.status === "completed" && c.aboard > 0) {
    out.push({ sev: "high", key: "after", short: `${c.aboard} still aboard`,
      text: `${c.aboard} still marked aboard after the trip ended.` });
  }
  if (trip.status === "completed" && !trip.sweep) {
    out.push({ sev: "high", key: "sweep", short: "Sweep not confirmed", text: "Trip is completed but nobody confirmed the bus is empty." });
  }
  for (const rider of trip.riders) {
    if (rider.state === "no_show" && !rider.handled) {
      const guardian = rider.guardians[0];
      out.push({ sev: "med", key: "noshow", rider, short: "No-show follow up",
        text: `${rider.givenName} was not at ${stopLabel(trip, rider.stopId)}.${guardian ? ` Contact ${guardian.name}.` : ""}` });
    }
    if (missed(trip, rider)) {
      out.push({ sev: "med", key: "missed", rider, short: "Not checked",
        text: `${rider.givenName} was not checked at ${stopLabel(trip, rider.stopId)}.` });
    }
  }
  if ((trip.status === "planned" || trip.status === "active") && !trip.assignedStaff) {
    out.push({ sev: "med", key: "nomon", short: "No monitor", text: "No staff assigned. Check-in cannot start." });
  }
  return out;
}

export function pillWord(state: CheckRider["state"]) {
  return { expected: "WAITING", aboard: "ABOARD", dropped: "OFF", no_show: "NO-SHOW", not_riding: "NOT RIDING" }[state];
}

export function pillClass(state: CheckRider["state"]) {
  return { expected: "expected", aboard: "aboard", dropped: "dropped", no_show: "noshow", not_riding: "absent" }[state];
}
