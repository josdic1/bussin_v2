import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { tripScheduleInputSchema } from "@bussin/shared";
import { buildScheduledTrips, CAMP_TIME_ZONE, removeUntouchedTrips } from "./schedules/build.js";

// Repeating trips (migration 041): one trip per day it runs, crew included, never twice,
// a cancelled day stays cancelled, and a change only takes back trips nobody has touched.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("a repeating trip builds its days, once, with its crew", async () => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`sc-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`sc-${tag}`, family]);
    const jcc = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'JCC', 40.75, -74.26)", [route]);
    await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 2, 'Camp', 40.8, -74.7)", [route]);
    const rider = await id("INSERT INTO riders (given_name, family_name) VALUES ('Izzy', $1)", [tag]);
    await client.query("INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, 'AM', $2, $3)", [rider, route, jcc]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`SC ${tag}`]);
    const local = (await client.query<{ day: string }>(
      "SELECT to_char((now() AT TIME ZONE $1)::date + 1, 'YYYY-MM-DD') AS day", [CAMP_TIME_ZONE])).rows[0]!.day;
    const schedule = (days: number[], busId = bus) => id(
      `INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, lead_id, created_by)
       VALUES ($1, $2, $3, '08:00', $4::date, $4::date + 6, $5, $5)`, [route, busId, days, local, lead]);
    const tripsOf = async (scheduleId: string) => (await client.query<{ id: string; status: string; hour: string; riders: number; lead: string | null }>(
      `SELECT t.id, t.status, to_char(t.departure_at AT TIME ZONE $2, 'HH24:MI') AS hour,
              (SELECT count(*)::int FROM trip_riders r WHERE r.trip_id = t.id) AS riders,
              (SELECT a.member_id FROM staff_assignments a WHERE a.trip_id = t.id AND a.ended_at IS NULL AND a.crew_role = 'lead') AS lead
         FROM trips t WHERE t.schedule_id = $1 ORDER BY t.service_date`, [scheduleId, CAMP_TIME_ZONE])).rows;

    const everyDay = await schedule([1, 2, 3, 4, 5, 6, 7]);
    const first = await buildScheduledTrips(client, everyDay);
    assert.equal(first.built, 7, "one trip for each of the 7 days");
    const built = await tripsOf(everyDay);
    assert.ok(built.every((trip) => trip.hour === "08:00"), "leaves at 8:00 camp time");
    assert.ok(built.every((trip) => trip.riders === 1 && trip.lead === lead), "kids and the lead come along");
    assert.equal((await buildScheduledTrips(client, everyDay)).built, 0, "building again adds nothing");

    const mondays = await schedule([1], await id("INSERT INTO buses (label) VALUES ($1)", [`SC2 ${tag}`]));
    assert.equal((await buildScheduledTrips(client, mondays)).built, 1, "only the weekdays it runs");

    const clash = await schedule([1, 2, 3, 4, 5, 6, 7]);
    const refused = await buildScheduledTrips(client, clash);
    assert.equal(refused.built, 0, "the same bus can't be booked twice at 8:00");
    assert.equal(refused.skipped.length, 7);
    assert.match(refused.skipped[0]!.reason, /already has a trip/);
    await client.query("UPDATE trip_schedules SET stopped_at = now() WHERE id = $1", [clash]);

    // A cancelled day stays cancelled; a day with a check on it is kept when the plan changes.
    await client.query("UPDATE trips SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [built[0]!.id]);
    await client.query("INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, 'not_riding', $3)", [built[1]!.id, rider, lead]);
    assert.equal(await removeUntouchedTrips(client, everyDay), 5, "only the five untouched trips go");
    await client.query("UPDATE trip_schedules SET depart_time = '08:15' WHERE id = $1", [everyDay]);
    assert.equal((await buildScheduledTrips(client, everyDay)).built, 5, "the untouched days come back at the new time");
    const after = await tripsOf(everyDay);
    assert.equal(after.length, 7);
    assert.equal(after[0]!.status, "cancelled");
    assert.equal(after[1]!.hour, "08:00", "the touched trip keeps its old time for Dispatch to sort out");
    assert.ok(after.slice(2).every((trip) => trip.hour === "08:15"));

    await client.query("SAVEPOINT bad");
    await assert.rejects(client.query("INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, created_by) VALUES ($1, $2, '{8}', '08:00', now(), now(), $3)", [route, bus, lead]),
      "a day that isn't a weekday is refused");
    await client.query("ROLLBACK TO SAVEPOINT bad");

    const input = { routeId: route, busId: bus, weekdays: [1, 2], departTime: "08:00", startsOn: "2027-07-01", endsOn: "2027-08-20",
      crew: { leadId: null, counselorIds: [], driverId: null } };
    assert.equal(tripScheduleInputSchema.safeParse(input).success, true);
    assert.equal(tripScheduleInputSchema.safeParse({ ...input, endsOn: "2027-06-30" }).success, false, "ends before it starts");
    assert.equal(tripScheduleInputSchema.safeParse({ ...input, weekdays: [] }).success, false, "no days");
    assert.equal(tripScheduleInputSchema.safeParse({ ...input, departTime: "8am" }).success, false);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
