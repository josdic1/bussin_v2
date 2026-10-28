import { Router } from "express";
import {
  staffLocationSampleInputSchema,
  staffLocationSampleResponseSchema,
  staffTripResponseSchema,
  tripActionResponseSchema,
  tripActionSchema
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { applyTripAction } from "../trips/actions.js";
import { openStream } from "../sse.js";
import { subscribeToStaffTrips } from "./live.js";
import { BUS_PHONE_LIVE_SQL, readStaffTrip, STAFF_CHOSEN_TRIP } from "./tripView.js";
import { ingestLocation } from "./locationIngest.js";

export const staffRoutes = Router();


staffRoutes.get("/live", requireRole("staff"), async (_request, response) => {
  const member = currentMember(response);
  const stream = openStream(response);

  // Trip, stop-event and assignment triggers publish the affected member id.
  // Only real changes reach the phone; it reconciles on its own every 30s.
  const unsubscribe = await subscribeToStaffTrips((payload) => {
    try {
      const event = JSON.parse(payload) as { memberId?: unknown };
      if (event.memberId === member.id) stream.send("trip", "{}");
    } catch {
      // Ignore malformed database notifications.
    }
  });
  stream.onClose(unsubscribe);
  stream.send("ready", "{}");
});

staffRoutes.post(
  "/presence",
  requireSameOrigin,
  requireRole("staff"),
  async (_request, response) => {
    const member = currentMember(response);
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

staffRoutes.get("/trip", requireRole("staff"), async (_request, response) => {
  const member = currentMember(response);
  const trip = await readStaffTrip(STAFF_CHOSEN_TRIP, [member.id], member.id);
  response.json(staffTripResponseSchema.parse({ trip }));
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

    const member = currentMember(response);

    const assignment = await pool.query<{ tripId: string }>(
      `SELECT a.trip_id AS "tripId"
         FROM staff_assignments a
         JOIN trips t ON t.id = a.trip_id
        WHERE a.member_id = $1
          AND a.ended_at IS NULL
          AND t.status IN ('planned', 'active')
        ORDER BY (t.status = 'active') DESC, t.departure_at ASC, t.id
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

    const member = currentMember(response);

    // One round trip: confirms the assignment, detects a duplicate sample, and
    // records presence (an uploading phone is by definition reporting).
    const check = await pool.query<{ assigned: boolean; duplicate: boolean; busPhone: boolean }>(
      `WITH presence AS (
         INSERT INTO staff_presence (member_id, last_seen_at)
         VALUES ($1, now())
         ON CONFLICT (member_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
         RETURNING 1
       )
       SELECT EXISTS (
                SELECT 1
                  FROM staff_assignments a
                  JOIN trips t ON t.id = a.trip_id
                 WHERE a.member_id = $1
                   AND a.trip_id = $2
                   AND a.ended_at IS NULL
                   AND t.status = 'active'
              ) AS assigned,
              EXISTS (
                SELECT 1
                  FROM trip_location_samples
                 WHERE trip_id = $2
                   AND (client_sample_id = $3 OR observed_at = $4::timestamptz)
              ) AS duplicate,
              ${BUS_PHONE_LIVE_SQL("(SELECT bus_id FROM trips WHERE id = $2)")} AS "busPhone",
              (SELECT count(*) FROM presence) AS touched`,
      [member.id, input.data.tripId, input.data.clientSampleId, input.data.observedAt]
    );

    if (!check.rows[0]?.assigned) {
      response.status(409).json({ error: "This active trip is no longer assigned to you." });
      return;
    }

    // The bus's own phone is the GPS while it is live; staff phones are the backup.
    if (check.rows[0].busPhone) {
      response.status(200).json(staffLocationSampleResponseSchema.parse({ accepted: false, reason: "bus_phone" }));
      return;
    }

    if (check.rows[0].duplicate) {
      response.status(200).json(staffLocationSampleResponseSchema.parse({
        accepted: false,
        reason: "duplicate"
      }));
      return;
    }

    await ingestLocation(response, input.data, { memberId: member.id }, member.id);
  }
);
