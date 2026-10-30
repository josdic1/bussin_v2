import type { PoolClient } from "pg";
import { buildScheduledTrips, CURRENT_ROUTE } from "../schedules/build.js";
import { createTrip } from "../trips/create.js";
import { saveCrew } from "../dispatch/crew.js";

// Put the demo back to the start of a run: no trips have happened, no kids checked,
// no messages. Then every bus that has a morning (or afternoon) run gets that run
// leaving a few minutes from now, crew and kids included, so a demo can start any time
// of day. The plan itself (lines, buses, kids, team) is never touched.

const ACTIVITY = [
  "push_sent", "trip_alerts", "family_message_recipients", "family_messages", "trip_sweeps", "trip_rider_events",
  "trip_riders", "trip_current_locations", "trip_location_samples", "trip_events", "trip_driver_assignments",
  "staff_assignments", "trip_stops", "trips", "staff_presence", "data_edits"
];

export async function resetDemo(client: PoolClient, period: "AM" | "PM") {
  await client.query(`TRUNCATE ${ACTIVITY.join(", ")}`);
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
