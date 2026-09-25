import { Router } from "express";
import {
  staffLocationSampleInputSchema,
  staffLocationSampleResponseSchema,
  staffTripResponseSchema,
  tripActionResponseSchema,
  tripActionSchema
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { readSession } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { applyTripAction } from "../trips/actions.js";
import { subscribeToStaffTrips } from "./live.js";
import {
  locationDatabaseRejectionReason,
  locationSampleRejectionReason
} from "./locationPolicy.js";

export const staffRoutes = Router();

type StaffTripRow = {
  id: string;
  routeName: string;
  servicePeriod: "AM" | "PM";
  busLabel: string;
  departureAt: Date;
  status: "planned" | "active";
  stopId: string | null;
  position: number | null;
  stopLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
};

function sessionToken(cookieHeader: string | undefined): string | undefined {
  return cookieHeader?.split(/;\s*/)
    .find((part) => part.startsWith("bussin_session="))
    ?.slice("bussin_session=".length);
}

staffRoutes.get("/live", requireRole("staff"), async (request, response) => {
  const member = await readSession(sessionToken(request.headers.cookie));
  if (!member) {
    response.status(401).json({ error: "Session expired." });
    return;
  }

  response.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  response.flushHeaders();

  let closed = false;
  const unsubscribe = await subscribeToStaffTrips((payload) => {
    if (closed || response.writableEnded) return;
    try {
      const event = JSON.parse(payload) as { memberId?: unknown };
      if (event.memberId === member.id) {
        response.write("event: trip\ndata: {}\n\n");
      }
    } catch {
      // Ignore malformed database notifications.
    }
  });

  response.write("event: ready\ndata: {}\n\n");
  const reconciliation = setInterval(() => {
    if (!closed && !response.writableEnded) {
      response.write("event: sync\ndata: {}\n\n");
    }
  }, 5_000);
  reconciliation.unref();

  response.on("close", () => {
    closed = true;
    clearInterval(reconciliation);
    unsubscribe();
  });
});

staffRoutes.post(
  "/presence",
  requireSameOrigin,
  requireRole("staff"),
  async (request, response) => {
    const member = await readSession(sessionToken(request.headers.cookie));
    if (!member) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    await pool.query(
      `INSERT INTO staff_presence (member_id, last_seen_at)
       VALUES ($1, now())
       ON CONFLICT (member_id) DO UPDATE
       SET last_seen_at = EXCLUDED.last_seen_at`,
      [member.id]
    );

    response.status(204).end();
  }
);

staffRoutes.get("/trip", requireRole("staff"), async (request, response) => {
  const member = await readSession(sessionToken(request.headers.cookie));
  if (!member) {
    response.status(401).json({ error: "Session expired." });
    return;
  }

  const result = await pool.query<StaffTripRow>(
    `SELECT t.id,
            r.name AS "routeName",
            r.service_period AS "servicePeriod",
            b.label AS "busLabel",
            t.departure_at AS "departureAt",
            t.status,
            ts.id AS "stopId",
            ts.position,
            ts.label AS "stopLabel",
            ts.latitude::double precision AS latitude,
            ts.longitude::double precision AS longitude,
            arrived.occurred_at AS "arrivedAt",
            departed.occurred_at AS "departedAt"
       FROM staff_assignments a
       JOIN trips t ON t.id = a.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN trip_stops ts ON ts.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT e.occurred_at
           FROM trip_events e
          WHERE e.trip_id = t.id
            AND e.trip_stop_id = ts.id
            AND e.event_type = 'arrived_stop'
            AND NOT EXISTS (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)
          ORDER BY e.occurred_at DESC
          LIMIT 1
       ) arrived ON true
       LEFT JOIN LATERAL (
         SELECT e.occurred_at
           FROM trip_events e
          WHERE e.trip_id = t.id
            AND e.trip_stop_id = ts.id
            AND e.event_type = 'departed_stop'
            AND NOT EXISTS (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)
          ORDER BY e.occurred_at DESC
          LIMIT 1
       ) departed ON true
      WHERE a.member_id = $1
        AND a.ended_at IS NULL
        AND t.status IN ('planned', 'active')
      ORDER BY ts.position`,
    [member.id]
  );

  if (!result.rowCount) {
    response.json(staffTripResponseSchema.parse({ trip: null }));
    return;
  }

  const first = result.rows[0];
  const stops = result.rows.flatMap((row) => {
    if (row.stopId === null) return [];
    if (row.position === null || row.stopLabel === null ||
        row.latitude === null || row.longitude === null) {
      throw new Error(`Trip ${row.id} has an incomplete stop snapshot`);
    }
    return [{
      id: row.stopId,
      position: row.position,
      label: row.stopLabel,
      latitude: row.latitude,
      longitude: row.longitude,
      arrivedAt: row.arrivedAt?.toISOString() ?? null,
      departedAt: row.departedAt?.toISOString() ?? null
    }];
  });

  response.json(staffTripResponseSchema.parse({
    trip: {
      id: first.id,
      routeName: first.routeName,
      servicePeriod: first.servicePeriod,
      busLabel: first.busLabel,
      departureAt: first.departureAt.toISOString(),
      status: first.status,
      stops
    }
  }));
});


staffRoutes.post(
  "/trip/actions",
  requireSameOrigin,
  requireRole("staff"),
  async (request, response) => {
    const action = tripActionSchema.safeParse(request.body);
    if (!action.success || action.data.type === "cancel") {
      response.status(400).json({ error: "Choose a valid staff trip action." });
      return;
    }

    const member = await readSession(sessionToken(request.headers.cookie));
    if (!member) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const assignment = await pool.query<{ tripId: string }>(
      `SELECT a.trip_id AS "tripId"
         FROM staff_assignments a
         JOIN trips t ON t.id = a.trip_id
        WHERE a.member_id = $1
          AND a.ended_at IS NULL
          AND t.status IN ('planned', 'active')
        LIMIT 1`,
      [member.id]
    );

    if (!assignment.rowCount) {
      response.status(409).json({ error: "You do not have an open trip assignment." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await applyTripAction(client, {
        tripId: assignment.rows[0].tripId,
        action: action.data,
        actorId: member.id,
        assignedStaffMemberId: member.id
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
          response.status(409).json({ error: "This trip is no longer assigned to you." });
          return;
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
);

staffRoutes.post(
  "/trip/location",
  requireSameOrigin,
  requireRole("staff"),
  async (request, response) => {
    const input = staffLocationSampleInputSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: "Choose a valid location sample." });
      return;
    }

    const member = await readSession(sessionToken(request.headers.cookie));
    if (!member) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const assignment = await pool.query<{ tripId: string }>(
      `SELECT a.trip_id AS "tripId"
         FROM staff_assignments a
         JOIN trips t ON t.id = a.trip_id
        WHERE a.member_id = $1
          AND a.trip_id = $2
          AND a.ended_at IS NULL
          AND t.status = 'active'
        LIMIT 1`,
      [member.id, input.data.tripId]
    );

    if (!assignment.rowCount) {
      response.status(409).json({ error: "This active trip is no longer assigned to you." });
      return;
    }

    const duplicate = await pool.query(
      `SELECT 1
         FROM trip_location_samples
        WHERE trip_id = $1
          AND (client_sample_id = $2 OR observed_at = $3::timestamptz)
        LIMIT 1`,
      [assignment.rows[0].tripId, input.data.clientSampleId, input.data.observedAt]
    );

    if (duplicate.rowCount) {
      response.status(200).json(staffLocationSampleResponseSchema.parse({
        accepted: false,
        reason: "duplicate"
      }));
      return;
    }

    const rejectionReason = locationSampleRejectionReason(input.data);
    if (rejectionReason) {
      response.status(202).json(staffLocationSampleResponseSchema.parse({
        accepted: false,
        reason: rejectionReason
      }));
      return;
    }

    try {
      await pool.query(
        `INSERT INTO trip_location_samples (
           trip_id, member_id, client_sample_id, observed_at,
           latitude, longitude, accuracy_m, speed_mps, heading_degrees
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          assignment.rows[0].tripId,
          member.id,
          input.data.clientSampleId,
          input.data.observedAt,
          input.data.latitude,
          input.data.longitude,
          input.data.accuracyM,
          input.data.speedMps,
          input.data.headingDegrees
        ]
      );
    } catch (error) {
      const qualityRejection = locationDatabaseRejectionReason(error);
      if (qualityRejection) {
        response.status(202).json(staffLocationSampleResponseSchema.parse({
          accepted: false,
          reason: qualityRejection
        }));
        return;
      }

      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505") {
          response.status(200).json(staffLocationSampleResponseSchema.parse({
            accepted: false,
            reason: "duplicate"
          }));
          return;
        }
        if (error.code === "P0001") {
          response.status(409).json({ error: "This location sample no longer belongs to an active assigned trip." });
          return;
        }
      }
      throw error;
    }

    response.status(201).json(staffLocationSampleResponseSchema.parse({ accepted: true }));
  }
);
