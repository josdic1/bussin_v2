import type { CheckRider, CheckTrip, RiderCheckAction } from "@bussin/shared";

/*
 * Ride Check with no signal. A tap that can't reach the server is saved on the phone,
 * shown on screen at once, and sent in order when signal comes back, with the time it
 * was really tapped. Same idea as the GPS queue: closing or reloading never loses a tap.
 */

type State = CheckRider["state"];
export type QueuedTap =
  | { id: string; kind: "tap"; tripId: string; riderId: string; type: RiderCheckAction["type"]; expected: State; result: State | null; at: string }
  | { id: string; kind: "sweep"; tripId: string; at: string };

const KEY = "bussin-ride-check-queue";
const KEEP_MS = 6 * 60 * 60_000;

export function loadQueue(): QueuedTap[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const cutoff = Date.now() - KEEP_MS;
    return list.filter((item): item is QueuedTap =>
      !!item && typeof item === "object" && "id" in item && "kind" in item && "tripId" in item && "at" in item &&
      typeof item.at === "string" && Date.parse(item.at) > cutoff);
  } catch {
    return [];
  }
}

export function saveQueue(queue: QueuedTap[]) {
  try {
    if (queue.length) localStorage.setItem(KEY, JSON.stringify(queue));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the queue still works while the app stays open.
  }
}

/** What a tap turns the rider into. Undo depends on history the phone may not have, so it's unknown. */
export function resultOf(type: RiderCheckAction["type"], current: State): State | null {
  switch (type) {
    case "board": return "aboard";
    case "drop": return "dropped";
    case "no_show": return "no_show";
    case "not_riding": return "not_riding";
    case "handled": return current;
    case "undo": return null;
  }
}

/** The trip as the counselor should see it: the server's copy with this phone's unsent taps on top. */
export function withQueue(trip: CheckTrip, queue: QueuedTap[]): { trip: CheckTrip; pending: Set<string> } {
  const mine = queue.filter((item) => item.tripId === trip.id);
  const pending = new Set<string>();
  if (!mine.length) return { trip, pending };
  const riders = trip.riders.map((rider) => ({ ...rider }));
  let sweep = trip.sweep;
  for (const item of mine) {
    if (item.kind === "sweep") { sweep = sweep ?? { confirmedAt: item.at, confirmedBy: "you (sending)" }; continue; }
    const rider = riders.find((r) => r.riderId === item.riderId);
    if (!rider) continue;
    pending.add(rider.riderId);
    if (item.result) { rider.state = item.result; rider.stateAt = item.at; rider.stateBy = "You"; rider.handled = item.type === "handled"; }
  }
  return { trip: { ...trip, riders, sweep }, pending };
}

/** A whole-stop button, worked out on the phone with the same rules the server uses. */
export function bulkTargets(trip: CheckTrip, stopId: string, type: "board_waiting" | "drop_aboard"): CheckRider[] {
  const first = trip.stops[0]?.id;
  const last = trip.stops.at(-1)?.id;
  const boarding = type === "board_waiting";
  return trip.riders.filter((rider) => {
    const here = trip.servicePeriod === "AM"
      ? boarding ? rider.stopId === stopId : stopId === last
      : boarding ? stopId === first : rider.stopId === stopId;
    return here && rider.state === (boarding ? "expected" : "aboard");
  });
}

export function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}
