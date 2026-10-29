import type { PoolClient } from "pg";
import { CAMP_TIME_ZONE, SCHEDULE_HORIZON_DAYS } from "@bussin/shared";
import { pool } from "../db/pool.js";
import { createTrip } from "../trips/create.js";
import { CrewError, saveCrew } from "../dispatch/crew.js";

// Repeating trips become real trips here: every day in the next two weeks that a schedule
// covers and that has no trip yet gets one, crew included. Safe to run any time, from
// any number of servers: a lock makes builds take turns, and a schedule gets at most
// one trip per day (a cancelled day stays cancelled).

/** The camp's clock. Schedule times ("8:00") are local times here. */
export { CAMP_TIME_ZONE };
const BUILD_EVERY_MS = 60 * 60_000;

export type Skip = { scheduleId: string; day: string; reason: string };

/**
 * The newest version of a route. Editing a route that trips already used creates a new
 * version, so a schedule follows the chain forward instead of pointing at the old one.
 */
export const CURRENT_ROUTE = `
  WITH RECURSIVE chain AS (
    SELECT r.id, r.active, r.superseded_at FROM routes r WHERE r.id = $1
    UNION ALL
    SELECT n.id, n.active, n.superseded_at FROM routes n JOIN chain c ON n.supersedes_route_id = c.id
  )
  SELECT id, active FROM chain WHERE superseded_at IS NULL LIMIT 1`;

/** Build the missing trips. Caller owns the transaction. Pass a schedule id to build just that one. */
export async function buildScheduledTrips(client: PoolClient, scheduleId?: string): Promise<{ built: number; skipped: Skip[] }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('bussin_trip_schedules'))");
  const due = await client.query<{
    scheduleId: string; day: string; departure: Date; routeId: string; busId: string;
    leadId: string | null; counselorIds: string[]; driverId: string | null;
  }>(
    `SELECT s.id AS "scheduleId", to_char(d, 'YYYY-MM-DD') AS day,
            ((d::date + s.depart_time) AT TIME ZONE $1) AS departure,
            s.route_id AS "routeId", s.bus_id AS "busId",
            s.lead_id AS "leadId", s.counselor_ids AS "counselorIds", s.driver_id AS "driverId"
       FROM trip_schedules s
      CROSS JOIN LATERAL generate_series(
        GREATEST(s.starts_on, (now() AT TIME ZONE $1)::date),
        LEAST(s.ends_on, (now() AT TIME ZONE $1)::date + $2::int - 1),
        interval '1 day') d
      WHERE s.stopped_at IS NULL
        AND ($3::uuid IS NULL OR s.id = $3)
        AND extract(isodow FROM d)::smallint = ANY (s.weekdays)
        AND ((d::date + s.depart_time) AT TIME ZONE $1) > now()
        AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.schedule_id = s.id AND t.service_date = d::date)
      ORDER BY departure, s.id`,
    [CAMP_TIME_ZONE, SCHEDULE_HORIZON_DAYS, scheduleId ?? null]
  );

  let built = 0;
  const skipped: Skip[] = [];
  for (const row of due.rows) {
    const route = await client.query<{ id: string; active: boolean }>(CURRENT_ROUTE, [row.routeId]);
    if (!route.rows[0]?.active) {
      skipped.push({ scheduleId: row.scheduleId, day: row.day, reason: "The route is turned off." });
      continue;
    }
    await client.query("SAVEPOINT build_trip");
    const created = await createTrip(client, {
      routeId: route.rows[0].id, busId: row.busId, departure: row.departure,
      schedule: { id: row.scheduleId, day: row.day }
    });
    if (!created.ok) {
      await client.query("ROLLBACK TO SAVEPOINT build_trip");
      await client.query("RELEASE SAVEPOINT build_trip");
      skipped.push({ scheduleId: row.scheduleId, day: row.day, reason: created.error });
      continue;
    }
    built++;
    // The regular crew. If someone can't be seated (left camp, double-booked), the trip
    // still gets built and Dispatch sees it with no crew, the same as any unassigned trip.
    await client.query("SAVEPOINT build_crew");
    try {
      await saveCrew(client, created.trip.id, { leadId: row.leadId, counselorIds: row.counselorIds, driverId: row.driverId });
      await client.query("RELEASE SAVEPOINT build_crew");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT build_crew");
      await client.query("RELEASE SAVEPOINT build_crew");
      const code = error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
      const why = error instanceof CrewError ? error.message
        : code === "P0001" || code === "23505" || code === "23514" ? "someone on the crew can't be seated on this trip." : null;
      if (why === null) throw error;
      skipped.push({ scheduleId: row.scheduleId, day: row.day, reason: `Trip planned without its crew: ${why}` });
    }
    await client.query("RELEASE SAVEPOINT build_trip");
  }
  return { built, skipped };
}

/**
 * Take back the trips a schedule built that haven't happened yet and that nobody has
 * touched: no checks, no edits, no messages, no alerts. Used when a schedule changes or
 * stops, so the next build uses the new plan. Touched trips are left for Dispatch.
 */
export async function removeUntouchedTrips(client: PoolClient, scheduleId: string): Promise<number> {
  const trips = await client.query<{ id: string }>(
    `SELECT t.id FROM trips t
      WHERE t.schedule_id = $1 AND t.status = 'planned' AND t.departure_at > now()
        AND NOT EXISTS (SELECT 1 FROM trip_rider_events e WHERE e.trip_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM trip_events e WHERE e.trip_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM trip_alerts a WHERE a.trip_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM family_messages m WHERE m.trip_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM trip_location_samples s WHERE s.trip_id = t.id)
      FOR UPDATE`,
    [scheduleId]
  );
  const ids = trips.rows.map((row) => row.id);
  if (!ids.length) return 0;
  for (const table of ["staff_assignments", "trip_driver_assignments", "trip_riders", "trip_current_locations", "trip_sweeps", "trip_stops"]) {
    await client.query(`DELETE FROM ${table} WHERE trip_id = ANY($1::uuid[])`, [ids]);
  }
  await client.query("DELETE FROM trips WHERE id = ANY($1::uuid[])", [ids]);
  return ids.length;
}

/** Every hour (and once at startup): keep two weeks of repeating trips planned. */
export function startScheduleBuilder(): () => void {
  const run = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await buildScheduledTrips(client);
      await client.query("COMMIT");
      if (result.built) console.log(`Planned ${result.built} repeating trip(s)`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Building repeating trips failed", error);
    } finally {
      client.release();
    }
  };
  const first = setTimeout(() => void run(), 5_000);
  const timer = setInterval(() => void run(), BUILD_EVERY_MS);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
