import type { PoolClient } from "pg";
import { snapshotTripRiders } from "../families/access.js";

// Planning one trip: copy the route's stops onto the trip and snapshot who rides it.
// Used by Dispatch's "Plan trip" and by repeating trips. The caller owns the transaction.

export type CreatedTrip = {
  id: string; status: "planned" | "active" | "completed" | "cancelled";
  routeId: string; routeName: string; servicePeriod: "AM" | "PM";
  busId: string; busLabel: string; departureAt: Date; stopCount: number;
};
export type CreateTripResult = { ok: true; trip: CreatedTrip } | { ok: false; error: string };

export async function createTrip(client: PoolClient, input: {
  routeId: string; busId: string; departure: Date; schedule?: { id: string; day: string };
}): Promise<CreateTripResult> {
  const route = await client.query<{ id: string; name: string; servicePeriod: "AM" | "PM" }>(
    `SELECT id, name, service_period AS "servicePeriod"
       FROM routes
      WHERE id = $1 AND active = true AND superseded_at IS NULL
      FOR SHARE`,
    [input.routeId]
  );
  // Locking the bus serializes competing bookings for the same time.
  const bus = await client.query<{ id: string; label: string }>(
    "SELECT id, label FROM buses WHERE id = $1 AND active = true FOR UPDATE",
    [input.busId]
  );
  if (!route.rowCount || !bus.rowCount) return { ok: false, error: "The selected route or bus is unavailable." };

  const booked = await client.query(
    `SELECT 1 FROM trips t
      WHERE t.bus_id = $1 AND t.departure_at = $2
        AND t.status <> 'cancelled'
      LIMIT 1`,
    [bus.rows[0]!.id, input.departure]
  );
  if (booked.rowCount) return { ok: false, error: "This bus already has a trip at that time." };

  const stops = await client.query<{
    id: string; position: number; label: string; latitude: string | null; longitude: string | null;
  }>(
    `SELECT id, position, label, latitude, longitude
       FROM route_stops WHERE route_id = $1 ORDER BY position
       FOR SHARE`,
    [route.rows[0]!.id]
  );
  if (!stops.rowCount || stops.rows.some((stop) => stop.latitude === null || stop.longitude === null)) {
    return { ok: false, error: "The route needs stops with locations." };
  }

  const trip = await client.query<{ id: string; status: CreatedTrip["status"] }>(
    `INSERT INTO trips (route_id, bus_id, departure_at, schedule_id, service_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, status`,
    [route.rows[0]!.id, bus.rows[0]!.id, input.departure, input.schedule?.id ?? null, input.schedule?.day ?? null]
  );
  const tripId = trip.rows[0]!.id;
  for (const stop of stops.rows) {
    await client.query(
      `INSERT INTO trip_stops
       (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tripId, route.rows[0]!.id, stop.id, stop.position, stop.label, stop.latitude, stop.longitude]
    );
  }
  await snapshotTripRiders(client, tripId);
  return {
    ok: true,
    trip: {
      id: tripId, status: trip.rows[0]!.status,
      routeId: route.rows[0]!.id, routeName: route.rows[0]!.name, servicePeriod: route.rows[0]!.servicePeriod,
      busId: bus.rows[0]!.id, busLabel: bus.rows[0]!.label, departureAt: input.departure, stopCount: stops.rows.length
    }
  };
}
