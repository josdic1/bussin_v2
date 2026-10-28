import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

// Counselor phones (migration 038 and check routes): a rider event reaches the crew's
// live channel, and a bus phone that checked in recently counts as live.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("ride check taps notify the trip's crew", async () => {
  const listener = await pool.connect();
  const client = await pool.connect();
  const tag = randomUUID();
  const heard: string[] = [];
  try {
    await listener.query("LISTEN bussin_staff_trip");
    listener.on("notification", (message) => { if (message.payload) heard.push(message.payload); });
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    await client.query("BEGIN");
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`cc-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`cc-${tag}`, family]);
    const stop = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'Gate', 40.7, -74.2)", [route]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`CC ${tag}`]);
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, bus]);
    const tripStop = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 1, 'Gate', 40.7, -74.2)", [trip, route, stop]);
    const rider = await id("INSERT INTO riders (given_name, family_name) VALUES ('Kid', $1)", [tag]);
    await client.query("INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id) VALUES ($1, $2, $3)", [trip, rider, tripStop]);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, lead]);
    await client.query("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [trip]);
    await client.query("COMMIT");
    heard.length = 0;

    await client.query("INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, 'boarded', $3)", [trip, rider, lead]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(heard.some((payload) => payload.includes(lead)), "the lead's phone hears the tap");
  } finally {
    await listener.query("UNLISTEN *").catch(() => undefined);
    listener.release();
    client.release();
    await pool.end();
  }
});
