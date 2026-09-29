import type { BoardTrip, Bus } from "@bussin/shared";
import { age, ageShort, MIN, PALETTE, time } from "./format";

export type FleetStatus = "IN SERVICE" | "GPS STALE" | "PLANNED" | "AVAILABLE" | "INACTIVE";
export type Alert = { sev: "high" | "med"; kind: "gps" | "late" | "due" | "nodriver"; text: string; short: string };

export type BusRow = {
  bus: Bus;
  color: string;
  num: string;
  trips: BoardTrip[];
  trip: BoardTrip | null;
  status: FleetStatus;
  latestGps: string | null;
  alerts: Alert[];
  progress: { done: number; total: number } | null;
  next: { label: string; etaAt: string | null } | null;
};

const GPS_FRESH_MS = 60_000;
const EARLY_START_WARNING_MS = 10 * MIN;

/** One stable color per bus, by its position in the label-ordered fleet. */
export function busColors(buses: Bus[]) {
  const colors = new Map<string, string>();
  buses.forEach((bus, index) => colors.set(bus.id, PALETTE[index % PALETTE.length]));
  return (busId: string) => colors.get(busId) ?? PALETTE[0];
}

export function busNumber(label: string) {
  const digits = label.match(/\d+/)?.[0];
  return digits ?? label.slice(0, 2).toUpperCase();
}

/** Stops finished: departed, or the final stop once arrived. */
export function stopsDone(trip: BoardTrip) {
  return trip.stops.filter((stop, index) =>
    stop.departedAt || (index === trip.stops.length - 1 && stop.arrivedAt)).length;
}

/** Index of the stop the bus is heading to or standing at. */
export function currentStopIndex(trip: BoardTrip) {
  // The final stop is never departed, so this lands on it once earlier stops are done.
  const index = trip.stops.findIndex((stop) => !stop.departedAt);
  return index < 0 ? trip.stops.length - 1 : index;
}

export type NextAction =
  | { kind: "start" } | { kind: "assign" }
  | { kind: "arrive" | "depart"; stopId: string; stopLabel: string }
  | { kind: "complete" };

export function nextAction(trip: BoardTrip): NextAction | null {
  if (trip.status === "planned") return trip.assignedStaff ? { kind: "start" } : { kind: "assign" };
  if (trip.status !== "active" || !trip.stops.length) return null;
  const index = currentStopIndex(trip);
  const stop = trip.stops[index];
  const last = index === trip.stops.length - 1;
  if (!stop.arrivedAt) return { kind: "arrive", stopId: stop.id, stopLabel: stop.label };
  if (last) return { kind: "complete" };
  return { kind: "depart", stopId: stop.id, stopLabel: stop.label };
}

export function canComplete(trip: BoardTrip) {
  return trip.status === "active" && !!trip.stops.at(-1)?.arrivedAt &&
    trip.stops.slice(0, -1).every((stop) => stop.departedAt);
}

export function earlyStartMinutes(trip: BoardTrip, now: number) {
  const early = Date.parse(trip.departureAt) - now;
  return early > EARLY_START_WARNING_MS ? Math.ceil(early / MIN) : 0;
}

export function gpsFresh(trip: BoardTrip, now: number) {
  if (!trip.location) return false;
  const gpsAge = now - Date.parse(trip.location.observedAt);
  return gpsAge <= GPS_FRESH_MS && gpsAge >= -GPS_FRESH_MS;
}

export function gpsStale(trip: BoardTrip, now: number) {
  return trip.status === "active" && !gpsFresh(trip, now);
}

export function timing(trip: BoardTrip, now: number) {
  if (trip.status !== "planned") return null;
  const late = now - Date.parse(trip.departureAt);
  if (late >= MIN) return { kind: "overdue" as const, minutes: Math.floor(late / MIN) };
  if (late >= 0) return { kind: "due" as const, minutes: 0 };
  return null;
}

export function trackingText(trip: BoardTrip, now: number) {
  if (trip.status !== "active") {
    if (trip.status === "planned") {
      return Date.parse(trip.departureAt) < now
        ? "Departure time passed · trip not started" : "Tracking has not started";
    }
    return "No live tracking";
  }
  if (!trip.location) return "No live location yet";
  if (!gpsFresh(trip, now)) return `Location stale · last update ${time(trip.location.observedAt)}`;
  return `Live location · updated ${time(trip.location.observedAt)}`;
}

export function nextEta(trip: BoardTrip) {
  if (trip.status !== "active" || !trip.eta || !["live", "aging"].includes(trip.eta.status)) return null;
  return trip.eta.stops.find((stop) => !stop.actualArrival) ?? null;
}

export function etaText(trip: BoardTrip) {
  if (trip.status !== "active") return null;
  if (!trip.eta || trip.eta.status === "calculating") return "ETA calculating";
  if (trip.eta.status === "stale") return "ETA unavailable · location stale";
  if (trip.eta.status === "off-route") return "ETA unavailable · bus off route";
  if (trip.eta.status === "unavailable") return "ETA unavailable";
  const stop = nextEta(trip);
  if (!stop) return "ETA unavailable";
  const source = trip.eta.source === "mapbox-traffic" ? "traffic" : "live GPS pace";
  return `${stop.label} · ETA ${time(stop.etaAt)} · ${source}${trip.eta.status === "aging" ? " · location aging" : ""}`;
}

export function stopEta(trip: BoardTrip, stopId: string) {
  if (trip.status !== "active" || !trip.eta || !["live", "aging"].includes(trip.eta.status)) return null;
  const eta = trip.eta.stops.find((stop) => stop.stopId === stopId);
  return eta && !eta.actualArrival ? eta.etaAt : null;
}

export function presence(trip: BoardTrip, now: number) {
  if (!trip.assignedStaff || !["planned", "active"].includes(trip.status)) return null;
  if (!trip.staffLastSeenAt) return { ok: false, text: "Phone: NOT REPORTING · staff app not seen" };
  const seen = now - Date.parse(trip.staffLastSeenAt);
  const ago = seen < 10_000 ? "just now" : seen < 60_000 ? `${Math.floor(seen / 1000)} sec ago` : age(trip.staffLastSeenAt, now);
  return seen >= -5_000 && seen <= 30_000
    ? { ok: true, text: `Phone: ONLINE · seen ${ago}` }
    : { ok: false, text: `Phone: NOT REPORTING · last seen ${ago}` };
}

export function featuredTrip(trips: BoardTrip[], now: number) {
  const rank = (trip: BoardTrip) => trip.status === "active" ? 0
    : trip.status === "planned" && Date.parse(trip.departureAt) >= now ? 1
      : trip.status === "planned" ? 2 : trip.status === "completed" ? 3 : 4;
  return [...trips].sort((a, b) => rank(a) - rank(b) ||
    (rank(a) <= 1 ? Date.parse(a.departureAt) - Date.parse(b.departureAt)
      : Date.parse(b.departureAt) - Date.parse(a.departureAt)))[0] ?? null;
}

export function fleetRows(buses: Bus[], trips: BoardTrip[], now: number): BusRow[] {
  const colorOf = busColors(buses);
  return buses
    .filter((bus) => bus.active || trips.some((trip) => trip.busId === bus.id))
    .map((bus) => {
      const busTrips = trips.filter((trip) => trip.busId === bus.id)
        .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));
      const trip = featuredTrip(busTrips, now);
      const latestGps = busTrips.flatMap((item) => item.location ? [item.location.observedAt] : [])
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
      const running = busTrips.find((item) => item.status === "active");
      let status: FleetStatus;
      if (running) status = gpsFresh(running, now) ? "IN SERVICE" : "GPS STALE";
      else if (busTrips.some((item) => item.status === "planned")) status = "PLANNED";
      else if (!bus.active) status = "INACTIVE";
      else status = "AVAILABLE";

      const alerts: Alert[] = [];
      if (status === "GPS STALE") {
        alerts.push(latestGps
          ? { sev: "high", kind: "gps", text: `GPS silent for ${ageShort(latestGps, now)}`, short: `GPS silent ${ageShort(latestGps, now)}` }
          : { sev: "high", kind: "gps", text: "No GPS received since the trip started", short: "No GPS yet" });
      }
      const late = trip ? timing(trip, now) : null;
      if (late?.kind === "overdue") alerts.push({ sev: "high", kind: "late", text: `Not started, ${late.minutes} min past departure`, short: `${late.minutes} min late` });
      else if (late?.kind === "due") alerts.push({ sev: "med", kind: "due", text: "Departure due now", short: "Due now" });
      if (trip && (trip.status === "planned" || trip.status === "active") && !trip.assignedStaff) {
        alerts.push({ sev: "med", kind: "nodriver", text: "No driver assigned", short: "No driver" });
      }

      const eta = trip ? nextEta(trip) : null;
      const current = trip?.status === "active" ? trip.stops[currentStopIndex(trip)] : null;
      return {
        bus, color: colorOf(bus.id), num: busNumber(bus.label), trips: busTrips, trip, status, latestGps, alerts,
        progress: trip ? { done: stopsDone(trip), total: trip.stops.length } : null,
        next: current ? { label: eta?.label ?? current.label, etaAt: eta?.etaAt ?? null } : null
      };
    });
}

export function severityRank(row: BusRow) {
  if (row.alerts.some((alert) => alert.sev === "high")) return 0;
  if (row.alerts.length) return 1;
  if (row.trip?.status === "active") return 2;
  if (row.trip?.status === "planned") return 3;
  return 4;
}

/** Short plain phrase for the simple phone views. */
export function plainState(row: BusRow, now: number): { word: string; tone: "ok" | "bad" | "warn" | "" } {
  const trip = row.trip;
  if (!trip) return { word: "No trip", tone: "" };
  if (trip.status === "cancelled") return { word: "Cancelled", tone: "bad" };
  if (trip.status === "completed") return { word: "Finished", tone: "" };
  if (trip.status === "planned") {
    const late = timing(trip, now);
    if (late?.kind === "overdue") return { word: "Late, not left", tone: "bad" };
    if (late) return { word: "Leaving now", tone: "warn" };
    if (!trip.assignedStaff) return { word: "No driver", tone: "warn" };
    return { word: `Leaves ${time(trip.departureAt)}`, tone: "" };
  }
  if (gpsStale(trip, now)) return { word: "Running, no GPS", tone: "bad" };
  return { word: "Running", tone: "ok" };
}

export const STATUS_SLUG: Record<string, string> = {
  "IN SERVICE": "in-service", "GPS STALE": "gps-stale", PLANNED: "planned", AVAILABLE: "available", INACTIVE: "inactive"
};
