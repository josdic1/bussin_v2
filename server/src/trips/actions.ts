import type { PoolClient } from "pg";
import type { z } from "zod";
import { GPS_FAR_CODE, tripActionSchema, type ArrivalMethod } from "@bussin/shared";
import { nameList, unaccountedRiders } from "../check/accounted.js";

type TripAction = z.infer<typeof tripActionSchema>;

export type TripActionOutcome =
  | { ok: true; status: "active" | "completed" | "cancelled" }
  | { ok: false; httpStatus: 404 | 409; error: string; code?: typeof GPS_FAR_CODE };

/*
 * GPS is the source of truth for where the bus is; a tap is the backup.
 * A phone tapping Arrived while fresh, accurate GPS puts the bus further than this from
 * the stop is refused once. The person can answer "I'm here anyway" (override), which is
 * saved and marked so Dispatch can double-check. With no fresh GPS the tap is simply saved.
 */
export const GPS_GUARD = { farM: 300, freshMs: 45_000, maxAccuracyM: 100 } as const;
export const OVERRIDE_NOTE = "gps:override";

/** The trip_events note says who recorded an arrival. */
export function arrivalMethodOf(note: string | null): ArrivalMethod {
  return note === "journey:gps" ? "automatic" : note === OVERRIDE_NOTE ? "override" : "manual";
}

function distanceLabel(meters: number): string {
  return meters < 1609 ? `${Math.round(meters * 3.281 / 50) * 50} ft` : `${(meters / 1609.34).toFixed(1)} mi`;
}

export async function applyTripAction(
  client: PoolClient,
  input: {
    tripId: string;
    action: TripAction;
    actorId: string;
    assignedStaffMemberId?: string;
    eventNote?: string;
    /** When the event really happened (GPS evidence time). Defaults to now. */
    occurredAt?: Date;
    /** A person's tap on a phone: check Arrived against GPS first. */
    gpsGuard?: boolean;
    /** A counselor finishing: every kid must be accounted for first (not Waiting, not On bus). */
    requireAccounted?: boolean;
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
                 AND a.crew_role = 'lead'
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
    arrivalEventId: string | null;
  }>(
    `SELECT s.id, s.position,
            EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_stop_id = s.id
              AND e.event_type = 'arrived_stop' AND NOT EXISTS
                (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)) AS arrived,
            EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_stop_id = s.id
              AND e.event_type = 'departed_stop' AND NOT EXISTS
                (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)) AS departed,
            (SELECT e.id FROM trip_events e WHERE e.trip_stop_id = s.id
              AND e.event_type = 'arrived_stop' AND NOT EXISTS
                (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)
              ORDER BY e.occurred_at DESC, e.recorded_at DESC LIMIT 1) AS "arrivalEventId"
       FROM trip_stops s WHERE s.trip_id = $1 ORDER BY s.position`,
    [input.tripId]
  );

  const next = stops.rows.find((stop) => !stop.departed);
  const finalStop = stops.rows.at(-1);
  let eventType: string;
  let stopId: string | null = null;
  let update: string | null = null;
  let replacementEventId: string | null = null;
  let problem: string | null = null;
  let unaccounted: Awaited<ReturnType<typeof unaccountedRiders>> = [];

  switch (input.action.type) {
    case "start":
      if (trip.rows[0].status !== "planned") problem = "Only a planned trip can start.";
      else if (!trip.rows[0].hasAssignedStaff) problem = "Assign a lead counselor before starting the trip.";
      else if (!stops.rowCount) problem = "This trip has no stops.";
      else {
        const concurrent = await client.query(
          `SELECT 1
             FROM staff_assignments target
             JOIN staff_assignments other
               ON other.member_id = target.member_id
              AND other.ended_at IS NULL
              AND other.trip_id <> target.trip_id
             JOIN trips other_trip
               ON other_trip.id = other.trip_id
              AND other_trip.status = 'active'
            WHERE target.trip_id = $1
              AND target.ended_at IS NULL
            LIMIT 1`,
          [input.tripId]
        );
        if (concurrent.rowCount) {
          problem = "Assigned staff member is already running another trip.";
        } else {
          eventType = "started";
          update = "UPDATE trips SET status = 'active', started_at = now() WHERE id = $1";
        }
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
        if (input.gpsGuard && input.action.override !== true) {
          const where = await client.query<{ meters: number; label: string }>(
            `SELECT 2 * 6371000 * asin(sqrt(
                      power(sin(radians(sample.latitude - stop.latitude) / 2), 2) +
                      cos(radians(stop.latitude)) * cos(radians(sample.latitude)) *
                      power(sin(radians(sample.longitude - stop.longitude) / 2), 2)))::double precision AS meters,
                    stop.label
               FROM trip_current_locations current_location
               JOIN trip_location_samples sample ON sample.id = current_location.sample_id
               JOIN trip_stops stop ON stop.id = $2
              WHERE current_location.trip_id = $1
                AND sample.observed_at > now() - make_interval(secs => $3)
                AND sample.accuracy_m <= $4`,
            [input.tripId, next.id, GPS_GUARD.freshMs / 1000, GPS_GUARD.maxAccuracyM]
          );
          const far = where.rows[0];
          if (far && far.meters > GPS_GUARD.farM) {
            return { ok: false, httpStatus: 409, code: GPS_FAR_CODE,
              error: `GPS says the bus is ${distanceLabel(far.meters)} from ${far.label}.` };
          }
        }
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
    case "undo_arrival":
      if (trip.rows[0].status !== "active") problem = "Start the trip first.";
      else if (!next || next.id !== input.action.stopId || !next.arrived || next.departed || !next.arrivalEventId) {
        problem = "Only the current stop arrival can be undone before departure.";
      } else {
        eventType = "correction";
        stopId = next.id;
        replacementEventId = next.arrivalEventId;
      }
      break;
    case "complete":
      if (trip.rows[0].status !== "active" ||
          !finalStop?.arrived ||
          stops.rows.slice(0, -1).some((stop) => !stop.departed)) {
        problem = "Record departure from earlier stops and arrival at the final stop first.";
      } else if (input.requireAccounted && (unaccounted = await unaccountedRiders(client, input.tripId)).length) {
        const open = unaccounted;
        const waiting = open.filter((rider) => rider.state === "expected").map((rider) => rider.name);
        const aboard = open.filter((rider) => rider.state === "aboard").map((rider) => rider.name);
        problem = [
          waiting.length ? `${waiting.length} not checked: ${nameList(waiting)}.` : "",
          aboard.length ? `${aboard.length} still on the bus: ${nameList(aboard)}.` : "",
          "Mark each one before you finish."
        ].filter(Boolean).join(" ");
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
    `INSERT INTO trip_events (
       trip_id, event_type, trip_stop_id, recorded_by, note, replaces_event_id, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE(LEAST($7::timestamptz, now()), now()))`,
    [
      input.tripId,
      eventType!,
      stopId,
      input.actorId,
      input.action.type === "undo_arrival" ? "staff:undo-arrival"
        : input.action.type === "arrive" && input.action.override === true ? OVERRIDE_NOTE : input.eventNote ?? null,
      replacementEventId,
      input.occurredAt ?? null
    ]
  );

  return {
    ok: true,
    status: input.action.type === "start" ? "active"
      : input.action.type === "complete" ? "completed"
      : input.action.type === "cancel" ? "cancelled"
      : "active"
  };
}
