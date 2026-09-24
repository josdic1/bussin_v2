import { Router } from "express";
import { z } from "zod";
import {
  boardResponseSchema,
  createPlannedTripSchema,
  plannedTripSchema,
  plannedTripsResponseSchema
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

export const dispatchRoutes = Router();

const boardQuerySchema = z.strictObject({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true })
});

type BoardRow = TripRow & {
  stopId: string | null;
  position: number | null;
  stopLabel: string | null;
  stopLatitude: number | null;
  stopLongitude: number | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  observedAt: Date | null;
  accuracyM: number | null;
};

dispatchRoutes.get("/board", requireRole("admin", "dispatch"), async (request, response) => {
  const parsed = boardQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "Choose a valid day." });
    return;
  }
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (to.getTime() <= from.getTime() ||
      to.getTime() - from.getTime() > 48 * 60 * 60 * 1000) {
    response.status(400).json({ error: "Choose a single day." });
    return;
  }
  const result = await pool.query<BoardRow>(
    `WITH chosen AS (
       SELECT t.id, t.route_id, t.bus_id, t.status, sr.departure_at
         FROM trips t
         JOIN scheduled_runs sr ON sr.id = t.scheduled_run_id
        WHERE (sr.departure_at >= $1 AND sr.departure_at < $2)
           OR t.status = 'active'
        ORDER BY sr.departure_at DESC, t.id
        LIMIT 100
     )
     SELECT t.id, t.route_id AS "routeId", r.name AS "routeName",
            t.bus_id AS "busId", b.label AS "busLabel",
            t.departure_at AS "departureAt", t.status,
            count(ts.id) OVER (PARTITION BY t.id)::integer AS "stopCount",
            ts.id AS "stopId", ts.position, ts.label AS "stopLabel",
            ts.latitude::double precision AS "stopLatitude",
            ts.longitude::double precision AS "stopLongitude",
            arrived.occurred_at AS "arrivedAt",
            departed.occurred_at AS "departedAt",
            sample.latitude::double precision AS "locationLatitude",
            sample.longitude::double precision AS "locationLongitude",
            sample.observed_at AS "observedAt",
            sample.accuracy_m::double precision AS "accuracyM"
       FROM chosen t
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN trip_stops ts ON ts.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT e.occurred_at FROM trip_events e
          WHERE e.trip_id = t.id AND e.trip_stop_id = ts.id
            AND e.event_type = 'arrived_stop'
            AND NOT EXISTS (
              SELECT 1 FROM trip_events correction
               WHERE correction.replaces_event_id = e.id
            )
          ORDER BY e.occurred_at DESC LIMIT 1
       ) arrived ON true
       LEFT JOIN LATERAL (
         SELECT e.occurred_at FROM trip_events e
          WHERE e.trip_id = t.id AND e.trip_stop_id = ts.id
            AND e.event_type = 'departed_stop'
            AND NOT EXISTS (
              SELECT 1 FROM trip_events correction
               WHERE correction.replaces_event_id = e.id
            )
          ORDER BY e.occurred_at DESC LIMIT 1
       ) departed ON true
       LEFT JOIN trip_current_locations current_location ON current_location.trip_id = t.id
       LEFT JOIN trip_location_samples sample
         ON sample.id = current_location.sample_id
       ORDER BY t.departure_at, t.id, ts.position`,
    [from, to]
  );
  const trips = new Map<string, {
    id: string; routeId: string; routeName: string; busId: string;
    busLabel: string; departureAt: string; status: TripRow["status"];
    stopCount: number; stops: {
      id: string; position: number; label: string;
      latitude: number; longitude: number;
      arrivedAt: string | null; departedAt: string | null;
    }[]; location: {
      latitude: number; longitude: number;
      observedAt: string; accuracyM: number;
    } | null;
  }>();
  for (const row of result.rows) {
    let trip = trips.get(row.id);
    if (!trip) {
      trip = {
        id: row.id, routeId: row.routeId, routeName: row.routeName,
        busId: row.busId, busLabel: row.busLabel,
        departureAt: row.departureAt.toISOString(),
        status: row.status, stopCount: row.stopCount,
        stops: [],
        location: row.locationLatitude !== null &&
          row.locationLongitude !== null && row.observedAt && row.accuracyM !== null
          ? { latitude: row.locationLatitude, longitude: row.locationLongitude,
              observedAt: row.observedAt.toISOString(), accuracyM: row.accuracyM }
          : null
      };
      trips.set(row.id, trip);
    }
    if (row.stopId !== null) {
      if (row.position === null || row.stopLabel === null ||
          row.stopLatitude === null || row.stopLongitude === null) {
        throw new Error(`Trip ${row.id} has an incomplete stop snapshot`);
      }
      trip.stops.push({
        id: row.stopId, position: row.position, label: row.stopLabel,
        latitude: row.stopLatitude, longitude: row.stopLongitude,
        arrivedAt: row.arrivedAt?.toISOString() ?? null,
        departedAt: row.departedAt?.toISOString() ?? null
      });
    }
  }
  response.json(boardResponseSchema.parse({ trips: [...trips.values()] }));
});

type TripRow = {
  id: string;
  routeId: string;
  routeName: string;
  busId: string;
  busLabel: string;
  departureAt: Date;
  status: "planned" | "active" | "completed" | "cancelled";
  stopCount: number;
};

function toTrip(row: TripRow) {
  return plannedTripSchema.parse({
    ...row,
    departureAt: row.departureAt.toISOString()
  });
}

dispatchRoutes.get("/trips", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<TripRow>(
    `SELECT t.id, t.route_id AS "routeId", r.name AS "routeName",
            t.bus_id AS "busId", b.label AS "busLabel",
            sr.departure_at AS "departureAt", t.status,
            count(ts.id)::integer AS "stopCount"
       FROM trips t
       JOIN scheduled_runs sr ON sr.id = t.scheduled_run_id
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN trip_stops ts ON ts.trip_id = t.id
      GROUP BY t.id, r.id, b.id, sr.id
      ORDER BY sr.departure_at DESC, t.id
      LIMIT 100`
  );
  response.json(plannedTripsResponseSchema.parse({
    trips: result.rows.map(toTrip)
  }));
});

dispatchRoutes.post(
  "/trips",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const input = createPlannedTripSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: "Select a route, bus and departure time." });
      return;
    }
    const departure = new Date(input.data.departureAt);
    if (departure.getTime() <= Date.now()) {
      response.status(400).json({ error: "Departure must be in the future." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const route = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM routes WHERE id = $1 AND active = true FOR SHARE",
        [input.data.routeId]
      );
      const bus = await client.query<{ id: string; label: string }>(
        "SELECT id, label FROM buses WHERE id = $1 AND active = true FOR UPDATE",
        [input.data.busId]
      );
      if (!route.rowCount || !bus.rowCount) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "The selected route or bus is unavailable." });
        return;
      }

      // Locking the bus above serializes competing bookings for the same time.
      const booked = await client.query(
        `SELECT 1 FROM trips t
           JOIN scheduled_runs sr ON sr.id = t.scheduled_run_id
          WHERE t.bus_id = $1 AND sr.departure_at = $2
            AND t.status <> 'cancelled'
          LIMIT 1`,
        [bus.rows[0].id, departure]
      );
      if (booked.rowCount) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "This bus already has a trip at that time." });
        return;
      }
      const stops = await client.query<{
        id: string; position: number; label: string;
        latitude: string | null; longitude: string | null;
      }>(
        `SELECT id, position, label, latitude, longitude
           FROM route_stops WHERE route_id = $1 ORDER BY position
           FOR SHARE`,
        [route.rows[0].id]
      );
      if (!stops.rowCount || stops.rows.some((stop) =>
        stop.latitude === null || stop.longitude === null
      )) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "The route needs stops with locations." });
        return;
      }
      const run = await client.query<{ id: string }>(
        "INSERT INTO scheduled_runs (route_id, departure_at) VALUES ($1, $2) RETURNING id",
        [route.rows[0].id, departure]
      );
      const trip = await client.query<{ id: string; status: TripRow["status"] }>(
        `INSERT INTO trips (scheduled_run_id, route_id, bus_id)
         VALUES ($1, $2, $3) RETURNING id, status`,
        [run.rows[0].id, route.rows[0].id, bus.rows[0].id]
      );
      for (const stop of stops.rows) {
        await client.query(
          `INSERT INTO trip_stops
           (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [trip.rows[0].id, route.rows[0].id, stop.id,
           stop.position, stop.label, stop.latitude, stop.longitude]
        );
      }
      await client.query("COMMIT");
      response.status(201).json(toTrip({
        id: trip.rows[0].id,
        routeId: route.rows[0].id,
        routeName: route.rows[0].name,
        busId: bus.rows[0].id,
        busLabel: bus.rows[0].label,
        departureAt: departure,
        status: trip.rows[0].status,
        stopCount: stops.rows.length
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);
