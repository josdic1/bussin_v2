import type { PoolClient } from "pg";
import { deriveRiderState, type RiderEventRow } from "./state.js";

/**
 * Kids on a trip nobody has accounted for yet: still Waiting (never checked) or still On bus.
 * A counselor's phone can't finish a trip while this list has anyone on it, so no kid is
 * left at a stop or on the bus without someone deciding what happened.
 */
export async function unaccountedRiders(client: PoolClient, tripId: string) {
  const [riders, events] = await Promise.all([
    client.query<{ riderId: string; name: string }>(
      `SELECT tr.rider_id AS "riderId", r.given_name || ' ' || r.family_name AS name
         FROM trip_riders tr JOIN riders r ON r.id = tr.rider_id
        WHERE tr.trip_id = $1
        ORDER BY r.family_name, r.given_name, r.id`, [tripId]),
    client.query<RiderEventRow & { riderId: string }>(
      `SELECT e.rider_id AS "riderId", e.event_type AS "eventType", e.occurred_at AS "occurredAt",
              m.display_name AS "recordedByName"
         FROM trip_rider_events e JOIN members m ON m.id = e.recorded_by
        WHERE e.trip_id = $1
        ORDER BY e.occurred_at, e.recorded_at, e.id`, [tripId])
  ]);
  const byRider = new Map<string, RiderEventRow[]>();
  for (const { riderId, ...event } of events.rows) byRider.set(riderId, [...(byRider.get(riderId) ?? []), event]);
  return riders.rows.flatMap((rider) => {
    const state = deriveRiderState(byRider.get(rider.riderId) ?? []).state;
    return state === "expected" || state === "aboard" ? [{ name: rider.name, state }] : [];
  });
}

/** "Izzy Alpert, Carly Alpert and 3 more" */
export function nameList(names: string[], max = 3): string {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}
