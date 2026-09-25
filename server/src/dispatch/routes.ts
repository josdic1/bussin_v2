import { Router } from "express";
import { z } from "zod";
import {
  assignTripStaffSchema,
  boardResponseSchema,
  createPlannedTripSchema,
  dispatchStaffResponseSchema,
  plannedTripSchema,
  plannedTripsResponseSchema,
  tripActionResponseSchema,
  tripActionSchema,
  tripStaffAssignmentResponseSchema
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { readSession } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { snapshotTripRiders } from "../families/access.js";
import { applyTripAction } from "../trips/actions.js";
import { subscribeToDispatchLocations } from "./live.js";
import { buildDispatchEta } from "../eta/dispatchEta.js";

export const dispatchRoutes = Router();

const tripIdSchema = z.string().uuid();

dispatchRoutes.get("/live", requireRole("admin", "dispatch"), async (request, response) => {
  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  response.flushHeaders();

  let closed = false;
  const unsubscribe = await subscribeToDispatchLocations((payload) => {
    if (!closed && !response.writableEnded) {
      response.write(`event: location\ndata: ${payload}\n\n`);
    }
  });

  response.write("event: ready\ndata: {}\n\n");
  const heartbeat = setInterval(() => {
    if (!closed && !response.writableEnded) response.write(": keepalive\n\n");
  }, 25_000);
  heartbeat.unref();

  response.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  });
});

dispatchRoutes.get("/staff", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<{ id: string; displayName: string }>(
    `SELECT m.id, m.display_name AS "displayName"
       FROM members m
       JOIN member_roles r
         ON r.member_id = m.id
        AND r.role = 'staff'
        AND r.revoked_at IS NULL
      WHERE m.suspended_at IS NULL
      ORDER BY m.display_name, m.id`
  );

  response.json(dispatchStaffResponseSchema.parse({ staff: result.rows }));
});

dispatchRoutes.put(
  "/trips/:id/staff",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const tripId = tripIdSchema.safeParse(request.params.id);
    const input = assignTripStaffSchema.safeParse(request.body);
    if (!tripId.success || !input.success) {
      response.status(400).json({ error: "Choose a valid staff assignment." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const trip = await client.query<{ status: string }>(
        "SELECT status FROM trips WHERE id = $1 FOR UPDATE",
        [tripId.data]
      );
      if (!trip.rowCount) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Trip not found." });
        return;
      }
      if (trip.rows[0].status !== "planned") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Staff assignment can only change before the trip starts." });
        return;
      }

      const current = await client.query<{ id: string; memberId: string }>(
        `SELECT id, member_id AS "memberId"
           FROM staff_assignments
          WHERE trip_id = $1 AND ended_at IS NULL
          FOR UPDATE`,
        [tripId.data]
      );

      if (current.rows[0]?.memberId === input.data.memberId) {
        if (input.data.memberId === null) {
          await client.query("COMMIT");
          response.json(tripStaffAssignmentResponseSchema.parse({ assignedStaff: null }));
          return;
        }
        const member = await client.query<{ id: string; displayName: string }>(
          `SELECT id, display_name AS "displayName" FROM members WHERE id = $1`,
          [input.data.memberId]
        );
        await client.query("COMMIT");
        response.json(tripStaffAssignmentResponseSchema.parse({ assignedStaff: member.rows[0] }));
        return;
      }

      let staff: { id: string; displayName: string } | null = null;
      if (input.data.memberId !== null) {
        const member = await client.query<{ id: string; displayName: string }>(
          `SELECT m.id, m.display_name AS "displayName"
             FROM members m
             JOIN member_roles r
               ON r.member_id = m.id
              AND r.role = 'staff'
              AND r.revoked_at IS NULL
            WHERE m.id = $1 AND m.suspended_at IS NULL`,
          [input.data.memberId]
        );
        if (!member.rowCount) {
          await client.query("ROLLBACK");
          response.status(409).json({ error: "Choose an active staff member." });
          return;
        }
        staff = member.rows[0];
      }

      if (current.rowCount) {
        await client.query(
          `UPDATE staff_assignments
              SET ended_at = GREATEST(now(), assigned_at)
            WHERE id = $1`,
          [current.rows[0].id]
        );
      }

      if (staff) {
        await client.query(
          "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
          [tripId.data, staff.id]
        );
      }

      await client.query("COMMIT");
      response.json(tripStaffAssignmentResponseSchema.parse({ assignedStaff: staff }));
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505") {
          response.status(409).json({ error: "That staff member is already assigned to another open trip." });
          return;
        }
        if (error.code === "P0001") {
          response.status(409).json({ error: "That staff assignment is no longer valid." });
          return;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
);

dispatchRoutes.post(
  "/trips/:id/actions",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const tripId = tripIdSchema.safeParse(request.params.id);
    const action = tripActionSchema.safeParse(request.body);
    if (!tripId.success || !action.success) {
      response.status(400).json({ error: "Choose a valid trip action." });
      return;
    }
    const token = request.headers.cookie?.split(/;\s*/)
      .find((part) => part.startsWith("bussin_session="))
      ?.slice("bussin_session=".length);
    const actor = await readSession(token);
    if (!actor) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await applyTripAction(client, {
        tripId: tripId.data, action: action.data, actorId: actor.id
      });
      if (!outcome.ok) {
        await client.query("ROLLBACK");
        response.status(outcome.httpStatus).json({ error: outcome.error });
        return;
      }
      await client.query("COMMIT");
      response.json(tripActionResponseSchema.parse({ status: outcome.status }));
    } catch (error) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505") {
          response.status(409).json({ error: "This bus already has an active trip." });
          return;
        }
        if (error.code === "P0001") {
          response.status(409).json({ error: "The trip no longer has a valid staff assignment." });
          return;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
);

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
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  staffLastSeenAt: Date | null;
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
       SELECT t.id, t.route_id, t.bus_id, t.status, t.departure_at
         FROM trips t
        WHERE (t.departure_at >= $1 AND t.departure_at < $2)
           OR t.status = 'active'
        ORDER BY t.departure_at DESC, t.id
        LIMIT 100
     )
     SELECT t.id, t.route_id AS "routeId", r.name AS "routeName",
            r.service_period AS "servicePeriod",
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
            sample.accuracy_m::double precision AS "accuracyM",
            assigned_staff.id AS "assignedStaffId",
            assigned_staff.display_name AS "assignedStaffName",
            staff_presence.last_seen_at AS "staffLastSeenAt"
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
       LEFT JOIN LATERAL (
         SELECT m.id, m.display_name
           FROM staff_assignments a
           JOIN members m ON m.id = a.member_id
          WHERE a.trip_id = t.id
          ORDER BY (a.ended_at IS NULL) DESC, a.assigned_at DESC, a.id DESC
          LIMIT 1
       ) assigned_staff ON true
       LEFT JOIN staff_presence ON staff_presence.member_id = assigned_staff.id
       ORDER BY t.departure_at, t.id, ts.position`,
    [from, to]
  );
  const trips = new Map<string, {
    id: string; routeId: string; routeName: string; servicePeriod: "AM" | "PM"; busId: string;
    busLabel: string; departureAt: string; status: TripRow["status"];
    stopCount: number; assignedStaff: { id: string; displayName: string } | null; stops: {
      id: string; position: number; label: string;
      latitude: number; longitude: number;
      arrivedAt: string | null; departedAt: string | null;
    }[]; location: {
      latitude: number; longitude: number;
      observedAt: string; accuracyM: number;
    } | null; staffLastSeenAt: string | null;
    eta: Awaited<ReturnType<typeof buildDispatchEta>>;
  }>();
  for (const row of result.rows) {
    let trip = trips.get(row.id);
    if (!trip) {
      trip = {
        id: row.id, routeId: row.routeId, routeName: row.routeName,
        servicePeriod: row.servicePeriod, busId: row.busId, busLabel: row.busLabel,
        departureAt: row.departureAt.toISOString(),
        status: row.status, stopCount: row.stopCount,
        assignedStaff: row.assignedStaffId && row.assignedStaffName
          ? { id: row.assignedStaffId, displayName: row.assignedStaffName }
          : null,
        stops: [],
        location: row.locationLatitude !== null &&
          row.locationLongitude !== null && row.observedAt && row.accuracyM !== null
          ? { latitude: row.locationLatitude, longitude: row.locationLongitude,
              observedAt: row.observedAt.toISOString(), accuracyM: row.accuracyM }
          : null,
        staffLastSeenAt: row.staffLastSeenAt?.toISOString() ?? null,
        eta: null
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
  await Promise.all(
    [...trips.values()].map(async (trip) => {
      if (trip.status !== "active") return;

      try {
        trip.eta = await buildDispatchEta(trip.id);
      } catch (error) {
        console.error(`Could not calculate ETA for trip ${trip.id}`, error);
        trip.eta = {
          status: "unavailable",
          source: null,
          generatedAt: null,
          stops: []
        };
      }
    })
  );

  response.json(boardResponseSchema.parse({ trips: [...trips.values()] }));
});

type TripRow = {
  id: string;
  routeId: string;
  routeName: string;
  servicePeriod: "AM" | "PM";
  busId: string;
  busLabel: string;
  departureAt: Date;
  status: "planned" | "active" | "completed" | "cancelled";
  stopCount: number;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
};

function toTrip(row: TripRow) {
  return plannedTripSchema.parse({
    id: row.id,
    routeId: row.routeId,
    routeName: row.routeName,
    servicePeriod: row.servicePeriod,
    busId: row.busId,
    busLabel: row.busLabel,
    departureAt: row.departureAt.toISOString(),
    status: row.status,
    stopCount: row.stopCount,
    assignedStaff: row.assignedStaffId && row.assignedStaffName
      ? { id: row.assignedStaffId, displayName: row.assignedStaffName }
      : null
  });
}

dispatchRoutes.get("/trips", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<TripRow>(
    `SELECT t.id, t.route_id AS "routeId", r.name AS "routeName",
            r.service_period AS "servicePeriod",
            t.bus_id AS "busId", b.label AS "busLabel",
            t.departure_at AS "departureAt", t.status,
            count(ts.id)::integer AS "stopCount",
            assigned_staff.id AS "assignedStaffId",
            assigned_staff.display_name AS "assignedStaffName"
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN trip_stops ts ON ts.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT m.id, m.display_name
           FROM staff_assignments a
           JOIN members m ON m.id = a.member_id
          WHERE a.trip_id = t.id
          ORDER BY (a.ended_at IS NULL) DESC, a.assigned_at DESC, a.id DESC
          LIMIT 1
       ) assigned_staff ON true
      GROUP BY t.id, r.id, b.id, assigned_staff.id, assigned_staff.display_name
      ORDER BY t.departure_at DESC, t.id
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
      const route = await client.query<{ id: string; name: string; servicePeriod: "AM" | "PM" }>(
        `SELECT id, name, service_period AS "servicePeriod"
           FROM routes
          WHERE id = $1 AND active = true AND superseded_at IS NULL
          FOR SHARE`,
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
          WHERE t.bus_id = $1 AND t.departure_at = $2
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
      const trip = await client.query<{ id: string; status: TripRow["status"] }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, $3) RETURNING id, status`,
        [route.rows[0].id, bus.rows[0].id, departure]
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
      await snapshotTripRiders(client, trip.rows[0].id);
      await client.query("COMMIT");
      response.status(201).json(toTrip({
        id: trip.rows[0].id,
        routeId: route.rows[0].id,
        routeName: route.rows[0].name,
        servicePeriod: route.rows[0].servicePeriod,
        busId: bus.rows[0].id,
        busLabel: bus.rows[0].label,
        departureAt: departure,
        status: trip.rows[0].status,
        stopCount: stops.rows.length,
        assignedStaffId: null,
        assignedStaffName: null
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);
