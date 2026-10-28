import { staffTripResponseSchema, type StaffTrip } from "@bussin/shared";
import { pool } from "../db/pool.js";

// The trip as a phone or bus tracker sees it: route, bus, status and every stop with
// its arrival and departure. chosenSql is a subquery returning one trip_id column:
// the staff phone picks by its assignment, the bus tracker picks by its bus.

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
  arrivalNote: string | null;
  departureNote: string | null;
  crewRole: "lead" | "counselor" | null;
  busPhoneLive: boolean;
};

/** A bus phone counts as live if it checked in within this long (it checks in every 20s). */
export const BUS_PHONE_LIVE_SQL = (busIdSql: string) => `EXISTS (
  SELECT 1 FROM bus_devices d
   WHERE d.bus_id = ${busIdSql} AND d.revoked_at IS NULL
     AND d.last_seen_at > now() - interval '90 seconds')`;

/** memberId: the staff phone asking, so the trip says whether they are the lead. null for the bus phone. */
export async function readStaffTrip(chosenSql: string, values: unknown[], memberId: string | null = null): Promise<StaffTrip | null> {
  const memberParam = `$${values.length + 1}::uuid`;
  const result = await pool.query<StaffTripRow>(
    `SELECT t.id,
            t.route_name AS "routeName",
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
            departed.occurred_at AS "departedAt",
            arrived.note AS "arrivalNote",
            departed.note AS "departureNote",
            (SELECT a.crew_role FROM staff_assignments a
              WHERE a.trip_id = t.id AND a.member_id = ${memberParam} AND a.ended_at IS NULL LIMIT 1) AS "crewRole",
            ${BUS_PHONE_LIVE_SQL("t.bus_id")} AS "busPhoneLive"
       FROM (
${chosenSql}       ) chosen
       JOIN trips t ON t.id = chosen.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN trip_stops ts ON ts.trip_id = t.id
       LEFT JOIN LATERAL (
         SELECT e.occurred_at, e.note
           FROM trip_events e
          WHERE e.trip_id = t.id
            AND e.trip_stop_id = ts.id
            AND e.event_type = 'arrived_stop'
            AND NOT EXISTS (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)
          ORDER BY e.occurred_at DESC
          LIMIT 1
       ) arrived ON true
       LEFT JOIN LATERAL (
         SELECT e.occurred_at, e.note
           FROM trip_events e
          WHERE e.trip_id = t.id
            AND e.trip_stop_id = ts.id
            AND e.event_type = 'departed_stop'
            AND NOT EXISTS (SELECT 1 FROM trip_events replacement WHERE replacement.replaces_event_id = e.id)
          ORDER BY e.occurred_at DESC
          LIMIT 1
       ) departed ON true
      ORDER BY ts.position`,
    [...values, memberId]
  );

  if (!result.rowCount) return null;

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
      departedAt: row.departedAt?.toISOString() ?? null,
      arrivalMethod: row.arrivedAt
        ? row.arrivalNote === "journey:gps" ? "automatic" : "manual"
        : null,
      departureMethod: row.departedAt
        ? row.departureNote === "journey:gps" ? "automatic" : "manual"
        : null
    }];
  });

  return staffTripResponseSchema.parse({
    trip: {
      id: first.id,
      routeName: first.routeName,
      servicePeriod: first.servicePeriod,
      busLabel: first.busLabel,
      departureAt: first.departureAt.toISOString(),
      status: first.status,
      stops,
      crewRole: first.crewRole,
      busPhoneLive: first.busPhoneLive
    }
  }).trip;
}

/** Staff phone: the member's open assignment, running trip first, then the next planned one. */
export const STAFF_CHOSEN_TRIP = `
         SELECT a.trip_id
           FROM staff_assignments a
           JOIN trips selected_trip ON selected_trip.id = a.trip_id
          WHERE a.member_id = $1
            AND a.ended_at IS NULL
            AND selected_trip.status IN ('planned', 'active')
          ORDER BY (selected_trip.status = 'active') DESC,
                   selected_trip.departure_at ASC,
                   selected_trip.id
          LIMIT 1
`;
