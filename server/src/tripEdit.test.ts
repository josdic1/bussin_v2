import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { editPlannedTrip } from "./trips/edit.js";
import { applyTripAction } from "./trips/actions.js";
import { snapshotTripRiders } from "./families/access.js";

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 1 }
  : { database: process.env.PGDATABASE, max: 1 });

test("planned trip management preserves operational history", async (t) => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0].id;
    const actor = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Plan test')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [actor]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`Plan ${tag}`]);
    const bus2 = await id("INSERT INTO buses (label) VALUES ($1)", [`Other ${tag}`]);
    const routeIds: string[] = [];
    const stopIds: string[] = [];
    const riders: string[] = [];
    for (const suffix of ["A", "B"]) {
      const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`${tag}-${suffix}`]);
      const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`${tag}-${suffix}`, family]);
      routeIds.push(route);
      const stop = await id("INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, 1, 'Pickup', 40.7, -74.2)", [route]);
      stopIds.push(stop);
      const rider = await id("INSERT INTO riders (given_name, family_name) VALUES ('Rider', $1)", [`${tag}-${suffix}`]);
      riders.push(rider);
      await client.query("INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, 'AM', $2, $3)", [rider, route, stop]);
    }
    const departureAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, $3)", [routeIds[0], bus, departureAt]);
    await client.query(`INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
      SELECT $1, route_id, id, position, label, latitude, longitude FROM route_stops WHERE route_id = $2`, [trip, routeIds[0]]);
    await snapshotTripRiders(client, trip);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, actor]);
    const original = { routeId: routeIds[0], busId: bus, departureAt };
    const input = { ...original, expected: original };
    let sequence = 0;
    async function isolated(name: string, run: () => Promise<void>) {
      await t.test(name, async () => {
        const savepoint = `plan_test_${++sequence}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try { await run(); } finally {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      });
    }
    await isolated("future bus/time edit retains assignment and writes audit", async () => {
      const next = new Date(Date.now() + 3 * 86400_000).toISOString();
      assert.deepEqual(await editPlannedTrip(client, trip, actor, { ...input, busId: bus2, departureAt: next }), { ok: true });
      const changed = await client.query("SELECT bus_id, departure_at FROM trips WHERE id = $1", [trip]);
      assert.equal(changed.rows[0].bus_id, bus2);
      assert.equal(changed.rows[0].departure_at.toISOString(), next);
      assert.equal((await client.query("SELECT 1 FROM staff_assignments WHERE trip_id = $1 AND ended_at IS NULL", [trip])).rowCount, 1);
      assert.equal((await client.query("SELECT 1 FROM trip_events WHERE trip_id = $1 AND event_type = 'note'", [trip])).rowCount, 1);
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, busId: bus2 })).ok, false, "stale editor cannot overwrite the new plan");
    });
    await isolated("route edit rebuilds stops and rider membership", async () => {
      assert.deepEqual(await editPlannedTrip(client, trip, actor, { ...input, routeId: routeIds[1] }), { ok: true });
      assert.equal((await client.query("SELECT route_stop_id FROM trip_stops WHERE trip_id = $1", [trip])).rows[0].route_stop_id, stopIds[1]);
      assert.deepEqual((await client.query("SELECT rider_id FROM trip_riders WHERE trip_id = $1", [trip])).rows.map((r) => r.rider_id), [riders[1]]);
    });
    await isolated("recorded rider checks block route replacement but allow bus changes", async () => {
      await client.query("INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, 'not_riding', $3)", [trip, riders[0], actor]);
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, routeId: routeIds[1] })).ok, false);
      assert.deepEqual(await editPlannedTrip(client, trip, actor, { ...input, busId: bus2 }), { ok: true });
      assert.equal((await client.query("SELECT 1 FROM trip_rider_events WHERE trip_id = $1", [trip])).rowCount, 1);
    });
    await isolated("occupied bus/time is rejected", async () => {
      await client.query("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, $3)", [routeIds[0], bus2, departureAt]);
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, busId: bus2 })).ok, false);
    });
    await isolated("invalid target and past rescheduling are rejected", async () => {
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, routeId: randomUUID() })).ok, false);
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, departureAt: new Date(Date.now() - 1000).toISOString() })).ok, false);
    });
    await isolated("running trip is protected by both service and database", async () => {
      const started = await applyTripAction(client, { tripId: trip, actorId: actor, action: { type: "start" } });
      assert.equal(started.ok, true);
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, busId: bus2 })).ok, false);
      await assert.rejects(client.query("UPDATE trips SET bus_id = $2 WHERE id = $1", [trip, bus2]), /Only a planned trip/);
    });
    await isolated("tomorrow's planned trip can be cancelled", async () => {
      assert.equal((await applyTripAction(client, { tripId: trip, actorId: actor, action: { type: "cancel" } })).ok, true);
      assert.equal((await client.query("SELECT status FROM trips WHERE id = $1", [trip])).rows[0].status, "cancelled");
      assert.equal((await editPlannedTrip(client, trip, actor, { ...input, busId: bus2 })).ok, false);
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
