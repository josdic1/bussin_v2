import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { applyTripAction } from "./trips/actions.js";

// Nobody left behind: a counselor can't finish while any kid is still Waiting or On bus.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("finish is locked until every kid is accounted for", async () => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`fg-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'PM')", [`fg-${tag}`, family]);
    const a = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'Camp', 40.8, -74.7)", [route]);
    const b = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 2, 'JCC', 40.75, -74.26)", [route]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`FG ${tag}`]);
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, bus]);
    const camp = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 1, 'Camp', 40.8, -74.7)", [trip, route, a]);
    const jcc = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 2, 'JCC', 40.75, -74.26)", [trip, route, b]);
    const izzy = await id("INSERT INTO riders (given_name, family_name) VALUES ('Izzy', $1)", [tag]);
    const carly = await id("INSERT INTO riders (given_name, family_name) VALUES ('Carly', $1)", [tag]);
    for (const rider of [izzy, carly]) await client.query("INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id) VALUES ($1, $2, $3)", [trip, rider, jcc]);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, lead]);
    const act = (action: Parameters<typeof applyTripAction>[1]["action"]) =>
      applyTripAction(client, { tripId: trip, actorId: lead, assignedStaffMemberId: lead, action, requireAccounted: true });
    const tap = (rider: string, type: string) => client.query(
      "INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by, occurred_at) VALUES ($1, $2, $3, $4, clock_timestamp())", [trip, rider, type, lead]);

    assert.equal((await act({ type: "start" })).ok, true);
    assert.equal((await act({ type: "arrive", stopId: camp })).ok, true);
    await tap(izzy, "boarded");                  // Carly never checked: left at camp
    assert.equal((await act({ type: "depart", stopId: camp })).ok, true);
    assert.equal((await act({ type: "arrive", stopId: jcc })).ok, true);

    const locked = await act({ type: "complete" });
    assert.equal(locked.ok, false);
    assert.match(!locked.ok ? locked.error : "", /1 not checked: Carly .*1 still on the bus: Izzy/);

    await tap(izzy, "dropped_off");
    await tap(carly, "no_show");
    assert.equal((await act({ type: "complete" })).ok, true);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
