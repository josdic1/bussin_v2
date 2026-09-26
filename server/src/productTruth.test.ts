import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { createRouteSchema, updateRouteSchema } from "@bussin/shared";
import { snapshotTripRiders } from "./families/access.js";
import { applyTripAction } from "./trips/actions.js";
import { locationSampleRejectionReason } from "./staff/locationPolicy.js";
import { etaAvailability } from "./eta/freshness.js";
import { buildTrafficStopEtas } from "./eta/stopEtas.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;

if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before running product-truth tests");
}

const pool = new Pool(
  databaseUrl
    ? { connectionString: databaseUrl, max: 1 }
    : { database: databaseName, max: 1 }
);

let savepointNumber = 0;

async function expectDatabaseError(
  client: PoolClient,
  expectedCode: string,
  action: () => Promise<unknown>
) {
  const savepoint = `product_truth_${++savepointNumber}`;
  await client.query(`SAVEPOINT ${savepoint}`);

  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);

  if (!caught) {
    assert.fail(`Expected PostgreSQL error ${expectedCode}, but the write succeeded`);
  }

  assert.equal(
    (caught as { code?: string }).code,
    expectedCode,
    `Expected PostgreSQL error ${expectedCode}`
  );
}

test("route inputs require explicit family and AM/PM", () => {
  const stops = [{ label: "Test stop", latitude: 40.75, longitude: -74.25 }];

  assert.equal(createRouteSchema.safeParse({ name: "Alpha", stops }).success, false);
  assert.equal(updateRouteSchema.safeParse({ name: "Alpha", stops }).success, false);

  assert.equal(createRouteSchema.safeParse({
    name: "Alpha AM",
    familyName: "Alpha",
    servicePeriod: "AM",
    stops
  }).success, true);
});

test("GPS quality policy classifies stale, future, and inaccurate fixes", () => {
  const now = Date.parse("2026-09-24T18:00:00.000Z");

  assert.equal(locationSampleRejectionReason({
    observedAt: "2026-09-24T17:58:59.000Z",
    accuracyM: 12
  }, now), "stale");

  assert.equal(locationSampleRejectionReason({
    observedAt: "2026-09-24T18:00:31.000Z",
    accuracyM: 12
  }, now), "future");

  assert.equal(locationSampleRejectionReason({
    observedAt: "2026-09-24T18:00:00.000Z",
    accuracyM: 101
  }, now), "poor_accuracy");

  assert.equal(locationSampleRejectionReason({
    observedAt: "2026-09-24T18:00:00.000Z",
    accuracyM: 15
  }, now), null);
});

test("ETA freshness never treats stale or off-route GPS as available", () => {
  const now = Date.parse("2026-09-26T14:00:00.000Z");

  assert.deepEqual(
    etaAvailability("2026-09-26T13:58:59.000Z", false, now),
    {
      freshness: "stale",
      available: false,
      ageSeconds: 61
    }
  );

  assert.deepEqual(
    etaAvailability("2026-09-26T13:59:55.000Z", true, now),
    {
      freshness: "off-route",
      available: false,
      ageSeconds: 5
    }
  );

  assert.equal(
    etaAvailability("2026-09-26T13:59:40.000Z", false, now).available,
    true
  );
});

test("an arrived stop is an actual arrival, not a future ETA", () => {
  const arrivedAt = "2026-09-26T14:02:00.000Z";

  const result = buildTrafficStopEtas(
    [{
      id: "stop-1",
      label: "Test stop",
      arrivedAt,
      departedAt: null
    }],
    [{
      durationSeconds: 30,
      distanceM: 200
    }],
    Date.parse("2026-09-26T14:03:00.000Z")
  );

  assert.deepEqual(result, [{
    stopId: "stop-1",
    label: "Test stop",
    etaAt: arrivedAt,
    durationSecondsFromNow: 0,
    distanceMFromNow: 0,
    actualArrival: true
  }]);
});

test("database protects Bussin product truth", async (t) => {
  const client = await pool.connect();
  const token = randomUUID().replaceAll("-", "").slice(0, 12);

  try {
    await client.query("BEGIN");

    const family = await client.query<{ id: string }>(
      "INSERT INTO route_families (name) VALUES ($1) RETURNING id",
      [`Test-${token}`]
    );
    const familyId = family.rows[0].id;

    const amRoute = await client.query<{ id: string }>(
      `INSERT INTO routes (name, route_family_id, service_period)
       VALUES ($1, $2, 'AM') RETURNING id`,
      [`Test-${token}-AM`, familyId]
    );
    const amRouteId = amRoute.rows[0].id;

    const pmRoute = await client.query<{ id: string }>(
      `INSERT INTO routes (name, route_family_id, service_period)
       VALUES ($1, $2, 'PM') RETURNING id`,
      [`Test-${token}-PM`, familyId]
    );
    const pmRouteId = pmRoute.rows[0].id;

    await t.test("AM/PM is constrained data", async () => {
      await expectDatabaseError(client, "23514", () => client.query(
        `INSERT INTO routes (name, route_family_id, service_period)
         VALUES ($1, $2, 'EVENING')`,
        [`Bad-${token}`, familyId]
      ));
    });

    await t.test("one route family can have separate AM and PM routes, but not two current AM routes", async () => {
      const periods = await client.query<{ servicePeriod: string }>(
        `SELECT service_period AS "servicePeriod"
           FROM routes
          WHERE route_family_id = $1 AND superseded_at IS NULL
          ORDER BY service_period`,
        [familyId]
      );
      assert.deepEqual(periods.rows.map((row) => row.servicePeriod), ["AM", "PM"]);

      await expectDatabaseError(client, "23505", () => client.query(
        `INSERT INTO routes (name, route_family_id, service_period)
         VALUES ($1, $2, 'AM')`,
        [`Duplicate-${token}-AM`, familyId]
      ));
    });

    const bus = await client.query<{ id: string }>(
      "INSERT INTO buses (label) VALUES ($1) RETURNING id",
      [`Test Bus ${token}`]
    );
    const busId = bus.rows[0].id;

    await t.test("live GPS updates have a database notification backstop", async () => {
      const trigger = await client.query<{ definition: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS definition
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'trip_current_locations'
            AND t.tgname = 'notify_dispatch_live_location'
            AND NOT t.tgisinternal`
      );
      assert.equal(trigger.rowCount, 1);
      assert.match(trigger.rows[0].definition, /notify_dispatch_live_location/i);
    });

    await t.test("staff trip changes have database notification backstops", async () => {
      const triggers = await client.query<{ name: string }>(
        `SELECT t.tgname AS name
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND t.tgname IN (
              'notify_staff_assignment_change',
              'notify_staff_trip_status_change',
              'notify_staff_trip_event_change'
            )
            AND NOT t.tgisinternal
          ORDER BY t.tgname`
      );
      assert.deepEqual(
        triggers.rows.map((row) => row.name),
        [
          "notify_staff_assignment_change",
          "notify_staff_trip_event_change",
          "notify_staff_trip_status_change"
        ]
      );
    });

    await t.test("staff presence keeps only the latest heartbeat per member", async () => {
      const staff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Presence Staff') RETURNING id`,
        [`presence-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [staff.rows[0].id]
      );

      await client.query(
        `INSERT INTO staff_presence (member_id, last_seen_at)
         VALUES ($1, now() - interval '1 minute')`,
        [staff.rows[0].id]
      );
      await client.query(
        `INSERT INTO staff_presence (member_id, last_seen_at)
         VALUES ($1, now())
         ON CONFLICT (member_id) DO UPDATE
         SET last_seen_at = EXCLUDED.last_seen_at`,
        [staff.rows[0].id]
      );

      const presence = await client.query<{ count: string; fresh: boolean }>(
        `SELECT count(*)::text AS count,
                bool_and(last_seen_at > now() - interval '10 seconds') AS fresh
           FROM staff_presence
          WHERE member_id = $1`,
        [staff.rows[0].id]
      );
      assert.equal(presence.rows[0].count, "1");
      assert.equal(presence.rows[0].fresh, true);
    });

    await t.test("trip is the single scheduling record", async () => {
      const legacyTable = await client.query<{ relation: string | null }>(
        "SELECT to_regclass('public.scheduled_runs')::text AS relation"
      );
      assert.equal(legacyTable.rows[0].relation, null);

      await expectDatabaseError(client, "23502", () => client.query(
        "INSERT INTO trips (route_id, bus_id) VALUES ($1, $2)",
        [pmRouteId, busId]
      ));
    });

    await t.test("staff assignment is one active staff member per planned trip", async () => {
      const staff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Test Staff') RETURNING id`,
        [`staff-${token}@example.test`]
      );
      const staffId = staff.rows[0].id;
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [staffId]
      );

      const nonStaff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Not Staff') RETURNING id`,
        [`not-staff-${token}@example.test`]
      );

      const firstTrip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, now() + interval '2 days') RETURNING id`,
        [pmRouteId, busId]
      );
      const secondTrip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, now() + interval '3 days') RETURNING id`,
        [pmRouteId, busId]
      );

      await expectDatabaseError(client, "P0001", () => client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [firstTrip.rows[0].id, nonStaff.rows[0].id]
      ));

      await expectDatabaseError(client, "P0001", () => client.query(
        `UPDATE trips
            SET status = 'active', started_at = now()
          WHERE id = $1`,
        [firstTrip.rows[0].id]
      ));

      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [firstTrip.rows[0].id, staffId]
      );

      await expectDatabaseError(client, "23505", () => client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [secondTrip.rows[0].id, staffId]
      ));

      await client.query(
        `UPDATE trips
            SET status = 'active', started_at = now()
          WHERE id = $1`,
        [firstTrip.rows[0].id]
      );

      await expectDatabaseError(client, "P0001", () => client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [firstTrip.rows[0].id, nonStaff.rows[0].id]
      ));

      await client.query(
        `UPDATE trips
            SET status = 'completed', ended_at = now()
          WHERE id = $1`,
        [firstTrip.rows[0].id]
      );

      const ended = await client.query<{ ended: boolean }>(
        `SELECT ended_at IS NOT NULL AS ended
           FROM staff_assignments
          WHERE trip_id = $1 AND member_id = $2`,
        [firstTrip.rows[0].id, staffId]
      );
      assert.equal(ended.rows[0].ended, true);

      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [secondTrip.rows[0].id, staffId]
      );

      const otherStaff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Other Staff') RETURNING id`,
        [`other-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [otherStaff.rows[0].id]
      );

      const unauthorizedAction = await applyTripAction(client, {
        tripId: secondTrip.rows[0].id,
        action: { type: "start" },
        actorId: otherStaff.rows[0].id,
        assignedStaffMemberId: otherStaff.rows[0].id
      });
      assert.deepEqual(unauthorizedAction, {
        ok: false,
        httpStatus: 409,
        error: "This trip is no longer assigned to you."
      });
    });

    await t.test("dispatch can cancel an active trip and close its staff assignment", async () => {
      const staff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Cancellation Staff') RETURNING id`,
        [`cancel-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [staff.rows[0].id]
      );

      const bus = await client.query<{ id: string }>(
        "INSERT INTO buses (label) VALUES ($1) RETURNING id",
        [`Cancel Test Bus ${token}`]
      );
      const trip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, now() + interval '5 days') RETURNING id`,
        [pmRouteId, bus.rows[0].id]
      );
      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [trip.rows[0].id, staff.rows[0].id]
      );
      await client.query(
        "UPDATE trips SET status = 'active', started_at = now() WHERE id = $1",
        [trip.rows[0].id]
      );

      const cancelled = await applyTripAction(client, {
        tripId: trip.rows[0].id,
        action: { type: "cancel" },
        actorId: staff.rows[0].id
      });
      assert.deepEqual(cancelled, { ok: true, status: "cancelled" });

      const state = await client.query<{
        status: string;
        tripEnded: boolean;
        assignmentEnded: boolean;
      }>(
        `SELECT t.status,
                t.ended_at IS NOT NULL AS "tripEnded",
                a.ended_at IS NOT NULL AS "assignmentEnded"
           FROM trips t
           JOIN staff_assignments a ON a.trip_id = t.id
          WHERE t.id = $1`,
        [trip.rows[0].id]
      );
      assert.deepEqual(state.rows[0], {
        status: "cancelled",
        tripEnded: true,
        assignmentEnded: true
      });
    });

    await t.test("GPS samples require the assigned staff member on an active trip", async () => {
      const assignedStaff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'GPS Staff') RETURNING id`,
        [`gps-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [assignedStaff.rows[0].id]
      );

      const otherStaff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Other GPS Staff') RETURNING id`,
        [`other-gps-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [otherStaff.rows[0].id]
      );

      const trip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, now() + interval '4 days') RETURNING id`,
        [pmRouteId, busId]
      );
      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [trip.rows[0].id, assignedStaff.rows[0].id]
      );
      await client.query(
        `UPDATE trips SET status = 'active', started_at = now() WHERE id = $1`,
        [trip.rows[0].id]
      );

      await client.query(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), now(), 40.75, -74.25, 12)`,
        [trip.rows[0].id, assignedStaff.rows[0].id]
      );

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), now() + interval '1 millisecond', 40.75, -74.25, 12)`,
        [trip.rows[0].id, otherStaff.rows[0].id]
      ));

      await client.query(
        `UPDATE trips
            SET status = 'completed', ended_at = now()
          WHERE id = $1`,
        [trip.rows[0].id]
      );
    });

    await t.test("GPS quality rules protect the current bus location", async () => {
      const staff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'GPS Quality Staff') RETURNING id`,
        [`gps-quality-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [staff.rows[0].id]
      );

      const trip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, clock_timestamp() + interval '5 days') RETURNING id`,
        [pmRouteId, busId]
      );
      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [trip.rows[0].id, staff.rows[0].id]
      );
      await client.query(
        `UPDATE trips
            SET status = 'active', started_at = clock_timestamp() - interval '10 minutes'
          WHERE id = $1`,
        [trip.rows[0].id]
      );

      const accepted = await client.query<{ id: string }>(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), clock_timestamp() - interval '5 seconds',
                 40.75, -74.25, 12)
         RETURNING id`,
        [trip.rows[0].id, staff.rows[0].id]
      );

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), clock_timestamp() - interval '2 minutes',
                 40.75, -74.25, 12)`,
        [trip.rows[0].id, staff.rows[0].id]
      ));

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), clock_timestamp() + interval '45 seconds',
                 40.75, -74.25, 12)`,
        [trip.rows[0].id, staff.rows[0].id]
      ));

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO trip_location_samples
           (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
         VALUES ($1, $2, gen_random_uuid(), clock_timestamp() + interval '5 milliseconds',
                 40.75, -74.25, 101)`,
        [trip.rows[0].id, staff.rows[0].id]
      ));

      const current = await client.query<{ sampleId: string }>(
        `SELECT sample_id AS "sampleId"
           FROM trip_current_locations
          WHERE trip_id = $1`,
        [trip.rows[0].id]
      );
      assert.equal(current.rows[0].sampleId, accepted.rows[0].id);

      await client.query(
        `UPDATE trips
            SET status = 'completed', ended_at = clock_timestamp()
          WHERE id = $1`,
        [trip.rows[0].id]
      );
    });

    await t.test("route revisions cannot rewrite route identity or history", async () => {
      await expectDatabaseError(client, "P0001", () => client.query(
        "UPDATE routes SET supersedes_route_id = id WHERE id = $1",
        [amRouteId]
      ));

      await expectDatabaseError(client, "23514", () => client.query(
        "UPDATE routes SET superseded_at = now() WHERE id = $1",
        [amRouteId]
      ));

      await client.query(
        "UPDATE routes SET active = false, superseded_at = now() WHERE id = $1",
        [amRouteId]
      );

      const otherFamily = await client.query<{ id: string }>(
        "INSERT INTO route_families (name) VALUES ($1) RETURNING id",
        [`Other-${token}`]
      );

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO routes
           (name, route_family_id, service_period, revision, supersedes_route_id)
         VALUES ($1, $2, 'AM', 2, $3)`,
        [`Wrong-family-${token}`, otherFamily.rows[0].id, amRouteId]
      ));

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO routes
           (name, route_family_id, service_period, revision, supersedes_route_id)
         VALUES ($1, $2, 'PM', 2, $3)`,
        [`Wrong-period-${token}`, familyId, amRouteId]
      ));

      await expectDatabaseError(client, "P0001", () => client.query(
        `INSERT INTO routes
           (name, route_family_id, service_period, revision, supersedes_route_id)
         VALUES ($1, $2, 'AM', 3, $3)`,
        [`Skipped-revision-${token}`, familyId, amRouteId]
      ));

      const revision = await client.query<{ revision: number; supersedesRouteId: string }>(
        `INSERT INTO routes
           (name, route_family_id, service_period, revision, supersedes_route_id)
         VALUES ($1, $2, 'AM', 2, $3)
         RETURNING revision, supersedes_route_id AS "supersedesRouteId"`,
        [`Test-${token}-AM-v2`, familyId, amRouteId]
      );
      assert.equal(revision.rows[0].revision, 2);
      assert.equal(revision.rows[0].supersedesRouteId, amRouteId);
    });

    await t.test("guardian leave buffer defaults to five and stays between zero and sixty minutes", async () => {
      const guardian = await client.query<{ id: string; leaveBufferMinutes: number }>(
        `INSERT INTO guardians (name, email)
         VALUES ($1, $2)
         RETURNING id, leave_buffer_minutes AS "leaveBufferMinutes"`,
        [`Buffer Guardian ${token}`, `buffer-${token}@example.test`]
      );

      assert.equal(guardian.rows[0].leaveBufferMinutes, 5);

      await client.query(
        `UPDATE guardians SET leave_buffer_minutes = 0 WHERE id = $1`,
        [guardian.rows[0].id]
      );

      await client.query(
        `UPDATE guardians SET leave_buffer_minutes = 60 WHERE id = $1`,
        [guardian.rows[0].id]
      );

      await expectDatabaseError(client, "23514", () => client.query(
        `UPDATE guardians SET leave_buffer_minutes = -1 WHERE id = $1`,
        [guardian.rows[0].id]
      ));

      await expectDatabaseError(client, "23514", () => client.query(
        `UPDATE guardians SET leave_buffer_minutes = 61 WHERE id = $1`,
        [guardian.rows[0].id]
      ));
    });

    await t.test("family access comes only from guardian -> rider -> trip", async () => {
      const routeStop = await client.query<{ id: string }>(
        `INSERT INTO route_stops (route_id, position, label, latitude, longitude)
         VALUES ($1, 1, 'Family test stop', 40.750000, -74.250000)
         RETURNING id`,
        [pmRouteId]
      );
      const routeStopId = routeStop.rows[0].id;

      const rider = await client.query<{ id: string }>(
        `INSERT INTO riders (given_name, family_name)
         VALUES ('Test', $1) RETURNING id`,
        [`Rider-${token}`]
      );
      const riderId = rider.rows[0].id;

      await client.query(
        `INSERT INTO rider_stop_assignments
           (rider_id, direction, route_id, route_stop_id)
         VALUES ($1, 'PM', $2, $3)`,
        [riderId, pmRouteId, routeStopId]
      );

      const trip = await client.query<{ id: string }>(
        `INSERT INTO trips (route_id, bus_id, departure_at)
         VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
        [pmRouteId, busId]
      );
      const tripId = trip.rows[0].id;

      const tripStop = await client.query<{ id: string }>(
        `INSERT INTO trip_stops
           (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
         VALUES ($1, $2, $3, 1, 'Family test stop', 40.750000, -74.250000)
         RETURNING id`,
        [tripId, pmRouteId, routeStopId]
      );
      const tripStopId = tripStop.rows[0].id;

      await snapshotTripRiders(client, tripId);

      const member = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Test Guardian') RETURNING id`,
        [`guardian-${token}@example.test`]
      );
      const memberId = member.rows[0].id;
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'family')",
        [memberId]
      );

      const guardian = await client.query<{ id: string }>(
        `INSERT INTO guardians (name, email, member_id)
         VALUES ('Test Guardian', $1, $2) RETURNING id`,
        [`guardian-${token}@example.test`, memberId]
      );
      await client.query(
        `INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
         VALUES ($1, $2, 'manual')`,
        [riderId, guardian.rows[0].id]
      );

      const access = await client.query<{ tripStopId: string }>(
        `SELECT trip_stop_id AS "tripStopId"
           FROM family_trip_access
          WHERE member_id = $1 AND rider_id = $2 AND trip_id = $3`,
        [memberId, riderId, tripId]
      );
      assert.equal(access.rowCount, 1);
      assert.equal(access.rows[0].tripStopId, tripStopId);

      const secondMember = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Second Test Guardian') RETURNING id`,
        [`guardian-two-${token}@example.test`]
      );
      const secondMemberId = secondMember.rows[0].id;

      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'family')",
        [secondMemberId]
      );

      const secondGuardian = await client.query<{ id: string }>(
        `INSERT INTO guardians (name, email, member_id)
         VALUES ('Second Test Guardian', $1, $2) RETURNING id`,
        [`guardian-two-${token}@example.test`, secondMemberId]
      );

      await client.query(
        `INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
         VALUES ($1, $2, 'manual')`,
        [riderId, secondGuardian.rows[0].id]
      );

      const secondAccess = await client.query<{ tripStopId: string }>(
        `SELECT trip_stop_id AS "tripStopId"
           FROM family_trip_access
          WHERE member_id = $1 AND rider_id = $2 AND trip_id = $3`,
        [secondMemberId, riderId, tripId]
      );

      assert.equal(secondAccess.rowCount, 1);
      assert.equal(secondAccess.rows[0].tripStopId, tripStopId);

      const unrelated = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Unrelated Guardian') RETURNING id`,
        [`unrelated-${token}@example.test`]
      );
      const unrelatedAccess = await client.query(
        "SELECT 1 FROM family_trip_access WHERE member_id = $1 AND trip_id = $2",
        [unrelated.rows[0].id, tripId]
      );
      assert.equal(unrelatedAccess.rowCount, 0);

      const oldRouteAccess = await client.query<{ relation: string | null }>(
        "SELECT to_regclass('public.family_route_access')::text AS relation"
      );
      assert.equal(oldRouteAccess.rows[0].relation, null);

      const accessKind = await client.query<{ relkind: string }>(
        `SELECT c.relkind
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'family_trip_access'`
      );
      assert.equal(accessKind.rows[0].relkind, "v");

      const familyTripStaff = await client.query<{ id: string }>(
        `INSERT INTO members (email, display_name)
         VALUES ($1, 'Family Trip Staff') RETURNING id`,
        [`family-trip-staff-${token}@example.test`]
      );
      await client.query(
        "INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')",
        [familyTripStaff.rows[0].id]
      );
      await client.query(
        "INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)",
        [tripId, familyTripStaff.rows[0].id]
      );
      await client.query(
        "UPDATE trips SET status = 'active', started_at = now() WHERE id = $1",
        [tripId]
      );

      // Once a trip is active, re-snapshotting cannot rewrite its rider membership.
      await client.query(
        "DELETE FROM rider_stop_assignments WHERE rider_id = $1 AND direction = 'PM'",
        [riderId]
      );
      await snapshotTripRiders(client, tripId);
      const preserved = await client.query<{ tripStopId: string }>(
        `SELECT trip_stop_id AS "tripStopId"
           FROM trip_riders
          WHERE trip_id = $1 AND rider_id = $2`,
        [tripId, riderId]
      );
      assert.equal(preserved.rowCount, 1);
      assert.equal(preserved.rows[0].tripStopId, tripStopId);
    });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});

test.after(async () => {
  await pool.end();
});
