import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { GPS_FAR_CODE } from "@bussin/shared";
import { applyTripAction, arrivalMethodOf, OVERRIDE_NOTE } from "./trips/actions.js";

// GPS is the source of truth; a tapped Arrived is the backup.
// No GPS: the tap saves. GPS far away: refused once. "I'm here anyway": saves, marked override.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("a tapped Arrived checks GPS first and can be overridden", async () => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`ag-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`ag-${tag}`, family]);
    const a = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'Gate', 40.700000, -74.200000)", [route]);
    const b = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 2, 'Oak St', 40.750000, -74.250000)", [route]);
    const c = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 3, 'Camp', 40.800000, -74.300000)", [route]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`AG ${tag}`]);
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, bus]);
    const stop1 = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 1, 'Gate', 40.700000, -74.200000)", [trip, route, a]);
    const stop2 = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 2, 'Oak St', 40.750000, -74.250000)", [trip, route, b]);
    const stop3 = await id("INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude) VALUES ($1, $2, $3, 3, 'Camp', 40.800000, -74.300000)", [trip, route, c]);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, lead]);
    const tap = (action: Parameters<typeof applyTripAction>[1]["action"]) =>
      applyTripAction(client, { tripId: trip, actorId: lead, assignedStaffMemberId: lead, action, gpsGuard: true });
    const gps = (latitude: number, longitude: number) => client.query(
      `INSERT INTO trip_location_samples (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
       VALUES ($1, $2, $3, clock_timestamp(), $4, $5, 10)`, [trip, lead, randomUUID(), latitude, longitude]);
    const lastNote = async (stopId: string) => (await client.query<{ note: string | null }>(
      `SELECT note FROM trip_events WHERE trip_stop_id = $1 AND event_type = 'arrived_stop' ORDER BY recorded_at DESC LIMIT 1`, [stopId])).rows[0]?.note ?? null;

    assert.equal((await tap({ type: "start" })).ok, true);

    // 1. No GPS yet: the tap is the only signal, so it saves.
    assert.equal((await tap({ type: "arrive", stopId: stop1 })).ok, true);
    assert.equal(arrivalMethodOf(await lastNote(stop1)), "manual");
    assert.equal((await tap({ type: "depart", stopId: stop1 })).ok, true);

    // 2. GPS puts the bus back at the Gate, miles from Oak St: refused once, with the distance.
    await gps(40.700000, -74.200000);
    const refused = await tap({ type: "arrive", stopId: stop2 });
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.code === GPS_FAR_CODE);
    assert.match(!refused.ok ? refused.error : "", /GPS says the bus is [\d.]+ mi from Oak St\./);

    // 3. "I'm here anyway": saved, and marked so Dispatch can double-check.
    assert.equal((await tap({ type: "arrive", stopId: stop2, override: true })).ok, true);
    assert.equal(await lastNote(stop2), OVERRIDE_NOTE);
    assert.equal(arrivalMethodOf(OVERRIDE_NOTE), "override");
    assert.equal((await tap({ type: "depart", stopId: stop2 })).ok, true);

    // 4. GPS agrees (bus right at Camp): the tap saves without asking.
    await gps(40.800100, -74.300100);
    assert.equal((await tap({ type: "arrive", stopId: stop3 })).ok, true);

    // 5. Undo steps the arrival back.
    assert.equal((await tap({ type: "undo_arrival", stopId: stop3 })).ok, true);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
