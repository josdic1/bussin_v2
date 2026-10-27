import type { PoolClient } from "pg";
import type { z } from "zod";
import type { updatePlannedTripSchema } from "@bussin/shared";
import { snapshotTripRiders } from "../families/access.js";

type Input = z.infer<typeof updatePlannedTripSchema>;
type Result = { ok: true } | { ok: false; httpStatus: number; error: string };

/** Caller owns the transaction: plan, stops, riders and audit entry commit together. */
export async function editPlannedTrip(
  client: PoolClient, tripId: string, actorId: string, input: Input
): Promise<Result> {
  const reject = (error: string, httpStatus = 409): Result => ({ ok: false, httpStatus, error });
  const selected = await client.query<{
    status: string; routeId: string; busId: string; departureAt: Date;
  }>(`SELECT status, route_id AS "routeId", bus_id AS "busId", departure_at AS "departureAt"
       FROM trips WHERE id = $1 FOR UPDATE`, [tripId]);
  const trip = selected.rows[0];
  if (!trip) return reject("Trip not found.", 404);
  if (trip.status !== "planned") return reject("Only a planned trip can be edited.");
  if (trip.routeId !== input.expected.routeId || trip.busId !== input.expected.busId ||
      trip.departureAt.getTime() !== Date.parse(input.expected.departureAt)) {
    return reject("This trip changed while you were editing. Close and reopen the editor.");
  }
  const departure = new Date(input.departureAt);
  const routeChanged = input.routeId !== trip.routeId;
  const timeChanged = departure.getTime() !== trip.departureAt.getTime();
  if (timeChanged && departure.getTime() <= Date.now()) return reject("Choose a future departure time.", 400);
  if (!routeChanged && !timeChanged && input.busId === trip.busId) return { ok: true };

  // Lock the target bus, as trip creation does, to serialize same-time bookings.
  const bus = await client.query(`SELECT id FROM buses WHERE id = $1 AND active FOR UPDATE`, [input.busId]);
  if (!bus.rowCount) return reject("The selected bus is unavailable.");
  const booked = await client.query(
    `SELECT 1 FROM trips WHERE bus_id = $1 AND departure_at = $2 AND id <> $3
       AND status <> 'cancelled' LIMIT 1`, [input.busId, departure, tripId]);
  if (booked.rowCount) return reject("This bus already has a trip at that time.");

  if (routeChanged) {
    // A changed route must never discard a recorded absence/check or stop event.
    const history = await client.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM trip_rider_events WHERE trip_id = $1)
          OR EXISTS (SELECT 1 FROM trip_events WHERE trip_id = $1 AND trip_stop_id IS NOT NULL)`, [tripId]);
    if (history.rowCount) return reject("This trip already has rider or stop records. You can change its bus or time, but changing its route requires cancelling and planning a new trip.");
    const route = await client.query(
      `SELECT id FROM routes WHERE id = $1 AND active AND superseded_at IS NULL FOR SHARE`, [input.routeId]);
    if (!route.rowCount) return reject("The selected route is unavailable.");
    const stops = await client.query<{ latitude: string | null; longitude: string | null }>(
      `SELECT latitude, longitude FROM route_stops WHERE route_id = $1 FOR SHARE`, [input.routeId]);
    if (!stops.rowCount || stops.rows.some((stop) => stop.latitude === null || stop.longitude === null)) {
      return reject("The route needs stops with locations.");
    }
    await client.query("DELETE FROM trip_riders WHERE trip_id = $1", [tripId]);
    await client.query("DELETE FROM trip_stops WHERE trip_id = $1", [tripId]);
  }
  await client.query(
    `UPDATE trips SET route_id = $2, bus_id = $3, departure_at = $4 WHERE id = $1`,
    [tripId, input.routeId, input.busId, departure]);
  if (routeChanged) {
    await client.query(
      `INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
       SELECT $1, route_id, id, position, label, latitude, longitude
         FROM route_stops WHERE route_id = $2 ORDER BY position`, [tripId, input.routeId]);
    await snapshotTripRiders(client, tripId);
  }
  await client.query(
    `INSERT INTO trip_events (trip_id, event_type, recorded_by, note) VALUES ($1, 'note', $2, $3)`,
    [tripId, actorId, JSON.stringify({ kind: "plan_edited", before: input.expected,
      after: { routeId: input.routeId, busId: input.busId, departureAt: input.departureAt } })]);
  return { ok: true };
}
