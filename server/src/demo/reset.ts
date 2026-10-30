import type { PoolClient } from "pg";
import { buildScheduledTrips, CURRENT_ROUTE } from "../schedules/build.js";
import { createTrip } from "../trips/create.js";
import { saveCrew } from "../dispatch/crew.js";
import { deleteTrips } from "./trips.js";

// Start a run over: today's and upcoming trips go (with their checks and messages); past
// days stay, so History and Reports keep their season. Then every bus that has a morning
// (or afternoon) run gets that run leaving a few minutes from now, crew and kids included,
// so a demo can start any time of day. The plan itself (lines, buses, kids, team) is never touched.

export async function resetDemo(client: PoolClient, period: "AM" | "PM") {
  const upcoming = await client.query<{ id: string }>(
    `SELECT id FROM trips WHERE departure_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`);
  await deleteTrips(client, upcoming.rows.map((row) => row.id));
  await client.query(`DELETE FROM staff_presence`);
  const schedules = await client.query<{
    id: string; routeId: string; busId: string; leadId: string | null; counselorIds: string[]; driverId: string | null;
  }>(
    `SELECT s.id, s.route_id AS "routeId", s.bus_id AS "busId", s.lead_id AS "leadId",
            s.counselor_ids AS "counselorIds", s.driver_id AS "driverId"
       FROM trip_schedules s JOIN routes r ON r.id = s.route_id
      WHERE s.stopped_at IS NULL AND r.service_period = $1
      ORDER BY s.depart_time, s.id`, [period]);

  let made = 0;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const [index, schedule] of schedules.rows.entries()) {
    const route = await client.query<{ id: string; active: boolean }>(CURRENT_ROUTE, [schedule.routeId]);
    if (!route.rows[0]?.active) continue;
    await client.query("SAVEPOINT demo_trip");
    const created = await createTrip(client, {
      routeId: route.rows[0].id, busId: schedule.busId,
      departure: new Date(Date.now() + (3 + index) * 60_000),
      schedule: { id: schedule.id, day: today }
    });
    if (!created.ok) { await client.query("ROLLBACK TO SAVEPOINT demo_trip"); continue; }
    try {
      await saveCrew(client, created.trip.id, { leadId: schedule.leadId, counselorIds: schedule.counselorIds, driverId: schedule.driverId });
      await client.query("RELEASE SAVEPOINT demo_trip");
      made++;
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT demo_trip");
    }
  }
  // The rest of the two weeks, so Lines and History look like a normal camp.
  await buildScheduledTrips(client);
  return made;
}
