import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { parseRideDays, rideDaysSchema, weekdaysLabel } from "@bussin/shared";
import { buildScheduledTrips, CAMP_TIME_ZONE } from "./schedules/build.js";
import { syncPlannedTripRiders } from "./families/access.js";

// Ride days (migration 042): a kid is on a trip only on their days; changing the days
// moves them on or off planned trips, but never off a trip where they were already checked.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("ride days typed in a spreadsheet", () => {
  assert.deepEqual(parseRideDays("Mon Wed Fri"), { ok: true, days: [1, 3, 5] });
  assert.deepEqual(parseRideDays("mon-thu"), { ok: true, days: [1, 2, 3, 4] });
  assert.deepEqual(parseRideDays("Tues, Thurs"), { ok: true, days: [2, 4] });
  assert.deepEqual(parseRideDays(""), { ok: true, days: null }, "blank is every day");
  assert.deepEqual(parseRideDays("Mon to Sun"), { ok: true, days: null }, "all seven is every day");
  assert.equal(parseRideDays("M").ok, false);
  assert.equal(parseRideDays("Fri-Mon").ok, false);
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5]), "Mon to Fri");
  assert.equal(weekdaysLabel([1, 3, 5]), "Mon, Wed, Fri");
  assert.equal(weekdaysLabel(null), "Every day");
  assert.equal(rideDaysSchema.safeParse([]).success, false, "no days at all is refused");
});

test("a kid is only on the bus on their ride days", async () => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`rd-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`rd-${tag}`, family]);
    const jcc = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'JCC', 40.75, -74.26)", [route]);
    await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 2, 'Camp', 40.8, -74.7)", [route]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`RD ${tag}`]);
    const everyDay = await id("INSERT INTO riders (given_name, family_name) VALUES ('Every', $1)", [tag]);
    const mwf = await id("INSERT INTO riders (given_name, family_name, ride_days) VALUES ('Mwf', $1, '{1,3,5}')", [tag]);
    for (const rider of [everyDay, mwf]) {
      await client.query("INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, 'AM', $2, $3)", [rider, route, jcc]);
    }
    const schedule = await id(
      `INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, created_by)
       VALUES ($1, $2, '{1,2,3,4,5,6,7}', '08:00', (now() AT TIME ZONE $3)::date + 1, (now() AT TIME ZONE $3)::date + 7, $4)`,
      [route, bus, CAMP_TIME_ZONE, lead]);
    assert.equal((await buildScheduledTrips(client, schedule)).built, 7);

    const ridesOn = async (rider: string) => (await client.query<{ dow: number }>(
      `SELECT extract(isodow FROM t.departure_at AT TIME ZONE $2)::int AS dow
         FROM trip_riders tr JOIN trips t ON t.id = tr.trip_id
        WHERE tr.rider_id = $1 AND t.schedule_id = $3 ORDER BY dow`, [rider, CAMP_TIME_ZONE, schedule])).rows.map((row) => row.dow);
    assert.deepEqual(await ridesOn(everyDay), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(await ridesOn(mwf), [1, 3, 5], "only Mon, Wed, Fri");

    // Tuesday gets added; Monday's trip already has a check on it, so Monday stays even after it's removed.
    const monday = (await client.query<{ id: string }>(
      `SELECT t.id FROM trips t WHERE t.schedule_id = $1 AND extract(isodow FROM t.departure_at AT TIME ZONE $2) = 1`,
      [schedule, CAMP_TIME_ZONE])).rows[0]!.id;
    await client.query("INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, 'not_riding', $3)", [monday, mwf, lead]);
    await client.query("UPDATE riders SET ride_days = '{2,3,5}' WHERE id = $1", [mwf]);
    await syncPlannedTripRiders(client);
    assert.deepEqual(await ridesOn(mwf), [1, 2, 3, 5]);

    await client.query("SAVEPOINT bad");
    await assert.rejects(client.query("UPDATE riders SET ride_days = '{}' WHERE id = $1", [mwf]), "no days refused");
    await client.query("ROLLBACK TO SAVEPOINT bad");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
