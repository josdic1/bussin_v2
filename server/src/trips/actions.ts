import type { PoolClient } from "pg";
import type { z } from "zod";
import { tripActionSchema } from "@bussin/shared";

type TripAction = z.infer<typeof tripActionSchema>;

export type TripActionOutcome =
  | { ok: true; status: "active" | "completed" | "cancelled" }
  | { ok: false; httpStatus: 404 | 409; error: string };

export async function applyTripAction(
  client: PoolClient,
  input: {
    tripId: string;
    action: TripAction;
    actorId: string;
    assignedStaffMemberId?: string;
  }
): Promise<TripActionOutcome> {
  const trip = await client.query<{
    status: string;
    hasAssignedStaff: boolean;
    actorIsAssigned: boolean;
  }>(
    `SELECT t.status,
            EXISTS (
              SELECT 1
                FROM staff_assignments a
                JOIN members m ON m.id = a.member_id
                JOIN member_roles r
                  ON r.member_id = m.id
                 AND r.role = 'staff'
                 AND r.revoked_at IS NULL
               WHERE a.trip_id = t.id
                 AND a.ended_at IS NULL
                 AND m.suspended_at IS NULL
            ) AS "hasAssignedStaff",
            CASE WHEN $2::uuid IS NULL THEN true ELSE EXISTS (
              SELECT 1
                FROM staff_assignments a
                JOIN members m ON m.id = a.member_id
                JOIN member_roles r
                  ON r.member_id = m.id
                 AND r.role = 'staff'
                 AND r.revoked_at IS NULL
               WHERE a.trip_id = t.id
                 AND a.member_id = $2
                 AND a.ended_at IS NULL
                 AND m.suspended_at IS NULL
            ) END AS "actorIsAssigned"
       FROM trips t
      WHERE t.id = $1
      FOR UPDATE`,
    [input.tripId, input.assignedStaffMemberId ?? null]
  );

  if (!trip.rowCount) {
    return { ok: false, httpStatus: 404, error: "Trip not found." };
  }

  if (!trip.rows[0].actorIsAssigned) {
    return { ok: false, httpStatus: 409, error: "This trip is no longer assigned to you." };
  }

  const stops = await client.query<{
    id: string;
    position: number;
    arrived: boolean;
    departed: boolean;
  }>(
    `SELECT s.id, s.position,
            EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_stop_id = s.id
              AND e.event_type = 'arrived_stop' AND NOT EXISTS
                (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)) AS arrived,
            EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_stop_id = s.id
              AND e.event_type = 'departed_stop' AND NOT EXISTS
                (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)) AS departed
       FROM trip_stops s WHERE s.trip_id = $1 ORDER BY s.position`,
    [input.tripId]
  );

  const next = stops.rows.find((stop) => !stop.departed);
  const finalStop = stops.rows.at(-1);
  let eventType: string;
  let stopId: string | null = null;
  let update: string | null = null;
  let problem: string | null = null;

  switch (input.action.type) {
    case "start":
      if (trip.rows[0].status !== "planned") problem = "Only a planned trip can start.";
      else if (!trip.rows[0].hasAssignedStaff) problem = "Assign an active staff member before starting the trip.";
      else if (!stops.rowCount) problem = "This trip has no stops.";
      else {
        eventType = "started";
        update = "UPDATE trips SET status = 'active', started_at = now() WHERE id = $1";
      }
      break;
    case "cancel":
      if (input.assignedStaffMemberId) problem = "Only dispatch can cancel a trip.";
      else if (trip.rows[0].status !== "planned" && trip.rows[0].status !== "active") {
        problem = "Only a planned or active trip can be cancelled.";
      } else {
        eventType = "cancelled";
        update = `UPDATE trips
                     SET status = 'cancelled',
                         cancelled_at = now(),
                         ended_at = CASE WHEN status = 'active' THEN now() ELSE ended_at END
                   WHERE id = $1`;
      }
      break;
    case "arrive":
      if (trip.rows[0].status !== "active") problem = "Start the trip first.";
      else if (!next || next.id !== input.action.stopId || next.arrived) {
        problem = "Arrive at the next stop in route order.";
      } else {
        eventType = "arrived_stop";
        stopId = next.id;
      }
      break;
    case "depart":
      if (trip.rows[0].status !== "active") problem = "Start the trip first.";
      else if (next?.id === finalStop?.id) {
        problem = "Complete the trip after arrival at the final stop.";
      } else if (!next || next.id !== input.action.stopId || !next.arrived) {
        problem = "Record arrival at this stop before departure.";
      } else {
        eventType = "departed_stop";
        stopId = next.id;
      }
      break;
    case "complete":
      if (trip.rows[0].status !== "active" ||
          !finalStop?.arrived ||
          stops.rows.slice(0, -1).some((stop) => !stop.departed)) {
        problem = "Record departure from earlier stops and arrival at the final stop first.";
      } else {
        eventType = "completed";
        update = "UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1";
      }
      break;
  }

  if (problem) {
    return { ok: false, httpStatus: 409, error: problem };
  }

  if (update) await client.query(update, [input.tripId]);
  await client.query(
    `INSERT INTO trip_events (trip_id, event_type, trip_stop_id, recorded_by)
     VALUES ($1, $2, $3, $4)`,
    [input.tripId, eventType!, stopId, input.actorId]
  );

  return {
    ok: true,
    status: input.action.type === "start" ? "active"
      : input.action.type === "complete" ? "completed"
      : input.action.type === "cancel" ? "cancelled"
      : "active"
  };
}
