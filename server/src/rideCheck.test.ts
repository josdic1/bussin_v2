import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { riderCheckActionSchema } from "@bussin/shared";
import { checkTransition, deriveRiderState, type RiderEventRow } from "./check/state.js";
import { snapshotTripRiders, syncPlannedTripRiders } from "./families/access.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;
if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before running ride check tests");
}
const pool = new Pool(
  databaseUrl ? { connectionString: databaseUrl, max: 1 } : { database: databaseName, max: 1 }
);

function event(eventType: RiderEventRow["eventType"], minute: number): RiderEventRow {
  return {
    eventType,
    occurredAt: new Date(Date.UTC(2026, 8, 29, 14, minute)),
    recordedByName: "Dispatch"
  };
}

test("rider state is replayed from the check log", () => {
  assert.equal(deriveRiderState([]).state, "expected");

  const boarded = deriveRiderState([event("boarded", 1)]);
  assert.equal(boarded.state, "aboard");
  assert.equal(boarded.boardedAt?.getUTCMinutes(), 1);

  const dropped = deriveRiderState([event("boarded", 1), event("dropped_off", 9)]);
  assert.equal(dropped.state, "dropped");
  assert.equal(dropped.boardedAt?.getUTCMinutes(), 1);

  const undone = deriveRiderState([event("boarded", 1), event("undone", 2)]);
  assert.equal(undone.state, "expected");
  assert.equal(undone.boardedAt, null);
});

test("handled applies to the current state only", () => {
  const handled = deriveRiderState([event("no_show", 1), event("handled", 3)]);
  assert.equal(handled.state, "no_show");
  assert.equal(handled.handled, true);

  const later = deriveRiderState([event("no_show", 1), event("handled", 3), event("boarded", 5)]);
  assert.equal(later.state, "aboard");
  assert.equal(later.handled, false);
});

test("check transitions follow explicit rules", () => {
  const waiting = deriveRiderState([]);
  const aboard = deriveRiderState([event("boarded", 1)]);

  assert.equal(checkTransition(waiting, "board", "planned").ok, false);
  assert.equal(checkTransition(waiting, "not_riding", "planned").ok, true);
  assert.equal(checkTransition(waiting, "board", "active").ok, true);
  assert.equal(checkTransition(waiting, "drop", "active").ok, false);
  assert.equal(checkTransition(aboard, "drop", "active").ok, true);
  assert.equal(checkTransition(aboard, "board", "active").ok, false);
  assert.equal(checkTransition(aboard, "handled", "active").ok, true);
  assert.equal(checkTransition(waiting, "undo", "active").ok, false);
  assert.equal(checkTransition(aboard, "undo", "active").ok, true);
  assert.equal(checkTransition(waiting, "no_show", "completed").ok, true);
  assert.equal(checkTransition(waiting, "not_riding", "completed").ok, false);
  assert.equal(checkTransition(aboard, "drop", "cancelled").ok, false);

  const noShow = deriveRiderState([event("no_show", 1)]);
  assert.equal(checkTransition(noShow, "board", "active").ok, true, "a late rider can still board");
  const handled = deriveRiderState([event("no_show", 1), event("handled", 2)]);
  assert.equal(checkTransition(handled, "handled", "active").ok, false);
});

test("check action input is a closed set", () => {
  assert.equal(riderCheckActionSchema.safeParse({ type: "board" }).success, true);
  assert.equal(riderCheckActionSchema.safeParse({ type: "teleport" }).success, false);
  assert.equal(riderCheckActionSchema.safeParse({ type: "board", extra: 1 }).success, false);
});

async function expectDatabaseError(client: PoolClient, action: () => Promise<unknown>, pattern: RegExp) {
  await client.query("SAVEPOINT ride_check_expect");
  let caught: unknown;
  try { await action(); } catch (error) { caught = error; }
  await client.query("ROLLBACK TO SAVEPOINT ride_check_expect");
  await client.query("RELEASE SAVEPOINT ride_check_expect");
  assert.ok(caught, "Expected the database to refuse the write");
  assert.match(String((caught as Error).message), pattern);
}

test("database protects ride check truth", async (t) => {
  const client = await pool.connect();
  const token = randomUUID().slice(0, 8);
  try {
    await client.query("BEGIN");
    const actor = (await client.query<{ id: string }>(
      `INSERT INTO members (email, display_name) VALUES ($1, 'Checker') RETURNING id`,
      [`checker-${token}@example.test`]
    )).rows[0].id;
    const staff = (await client.query<{ id: string }>(
      `INSERT INTO members (email, display_name) VALUES ($1, 'Monitor') RETURNING id`,
      [`monitor-${token}@example.test`]
    )).rows[0].id;
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [staff]);

    const familyId = (await client.query<{ id: string }>(
      "INSERT INTO route_families (name) VALUES ($1) RETURNING id", [`Check-${token}`]
    )).rows[0].id;
    const routeId = (await client.query<{ id: string }>(
      `INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'PM') RETURNING id`,
      [`Check-${token}-PM`, familyId]
    )).rows[0].id;
    const stopA = (await client.query<{ id: string }>(
      `INSERT INTO route_stops (route_id, position, label, latitude, longitude)
       VALUES ($1, 1, 'Camp', 40.75, -74.25) RETURNING id`, [routeId]
    )).rows[0].id;
    const stopB = (await client.query<{ id: string }>(
      `INSERT INTO route_stops (route_id, position, label, latitude, longitude)
       VALUES ($1, 2, 'Home', 40.76, -74.26) RETURNING id`, [routeId]
    )).rows[0].id;
    const busId = (await client.query<{ id: string }>(
      "INSERT INTO buses (label) VALUES ($1) RETURNING id", [`Check Bus ${token}`]
    )).rows[0].id;
    const riderId = (await client.query<{ id: string }>(
      "INSERT INTO riders (given_name, family_name) VALUES ('Ava', 'Lopez') RETURNING id"
    )).rows[0].id;
    const strangerId = (await client.query<{ id: string }>(
      "INSERT INTO riders (given_name, family_name) VALUES ('Not', 'OnTrip') RETURNING id"
    )).rows[0].id;
    await client.query(
      `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id)
       VALUES ($1, 'PM', $2, $3)`, [riderId, routeId, stopB]
    );

    const tripId = (await client.query<{ id: string }>(
      `INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
      [routeId, busId]
    )).rows[0].id;
    for (const [position, stop, label] of [[1, stopA, "Camp"], [2, stopB, "Home"]] as const) {
      await client.query(
        `INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, 40.75, -74.25)`,
        [tripId, routeId, stop, position, label]
      );
    }
    await snapshotTripRiders(client, tripId);

    const insertEvent = (type: string, rider = riderId) => client.query(
      `INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, $3, $4)`,
      [tripId, rider, type, actor]
    );

    await t.test("a planned trip only accepts not riding", async () => {
      await expectDatabaseError(client, () => insertEvent("boarded"), /Only not riding/);
      await insertEvent("not_riding");
    });

    await t.test("a checked rider survives a roster resync", async () => {
      await client.query("DELETE FROM rider_stop_assignments WHERE rider_id = $1", [riderId]);
      await syncPlannedTripRiders(client);
      const kept = await client.query("SELECT 1 FROM trip_riders WHERE trip_id = $1 AND rider_id = $2", [tripId, riderId]);
      assert.equal(kept.rowCount, 1);
    });

    await t.test("checks are only for riders on the trip", async () => {
      await expectDatabaseError(client, () => insertEvent("not_riding", strangerId), /not on this trip/);
    });

    await t.test("the check log is append-only", async () => {
      await expectDatabaseError(client, () => client.query(
        "UPDATE trip_rider_events SET event_type = 'boarded' WHERE trip_id = $1", [tripId]
      ), /append-only/);
      await expectDatabaseError(client, () => client.query(
        "DELETE FROM trip_rider_events WHERE trip_id = $1", [tripId]
      ), /append-only/);
    });

    await t.test("a sweep needs a running or completed trip", async () => {
      await expectDatabaseError(client, () => client.query(
        "INSERT INTO trip_sweeps (trip_id, recorded_by) VALUES ($1, $2)", [tripId, actor]
      ), /running or completed/);

      await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [tripId, staff]);
      await client.query("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [tripId]);
      await insertEvent("undone");
      await insertEvent("boarded");
      await client.query("INSERT INTO trip_sweeps (trip_id, recorded_by) VALUES ($1, $2)", [tripId, actor]);
      await expectDatabaseError(client, () => client.query(
        "DELETE FROM trip_sweeps WHERE trip_id = $1", [tripId]
      ), /append-only/);
    });

    await t.test("a cancelled trip refuses new checks", async () => {
      await client.query(
        "UPDATE trips SET status = 'cancelled', cancelled_at = now(), ended_at = now() WHERE id = $1",
        [tripId]
      );
      await expectDatabaseError(client, () => insertEvent("dropped_off"), /cancelled/);
    });
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});
