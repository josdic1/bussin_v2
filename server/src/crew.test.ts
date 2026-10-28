import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

// Trip crew rules (migration 033), checked straight against the database:
//   one driver at a time (swaps keep history), one lead counselor, at most 4 counselors,
//   nobody twice on one trip, and a trip only starts with a lead.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 1 }
  : { database: process.env.PGDATABASE, max: 1 });

test("trip crew rules", async (t) => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;

    const staff: string[] = [];
    for (let n = 0; n < 6; n += 1) {
      const member = await id("INSERT INTO members (email, display_name) VALUES ($1, $2)", [`${tag}-${n}@example.test`, `Counselor ${n}`]);
      await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [member]);
      staff.push(member);
    }
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`crew-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`crew-${tag}`, family]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`Crew ${tag}`]);
    const departure = new Date(Date.now() + 86400_000).toISOString();
    const newTrip = () => id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, $3)", [route, bus, departure]);
    const driverA = await id("INSERT INTO drivers (name, phone) VALUES ('Mike Driver', '973-555-0001')");
    const driverB = await id("INSERT INTO drivers (name) VALUES ('Tom Driver')");
    const retired = await id("INSERT INTO drivers (name, active) VALUES ('Old Driver', false)");

    let sequence = 0;
    async function isolated(name: string, run: () => Promise<void>) {
      await t.test(name, async () => {
        const savepoint = `crew_test_${++sequence}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try { await run(); } finally {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
      });
    }
    const refuses = async (sql: string, values: unknown[], pattern: RegExp) => {
      await client.query("SAVEPOINT expect_error");
      await assert.rejects(client.query(sql, values), pattern);
      await client.query("ROLLBACK TO SAVEPOINT expect_error");
    };
    const assign = (trip: string, member: string, role = "counselor") =>
      client.query("INSERT INTO staff_assignments (trip_id, member_id, crew_role) VALUES ($1, $2, $3)", [trip, member, role]);

    await isolated("an assignment with no crew role is the lead, as before", async () => {
      const trip = await newTrip();
      await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, staff[0]]);
      const row = await client.query("SELECT crew_role FROM staff_assignments WHERE trip_id = $1", [trip]);
      assert.equal(row.rows[0].crew_role, "lead");
    });

    await isolated("one lead per trip; a second lead is refused", async () => {
      const trip = await newTrip();
      await assign(trip, staff[0]!, "lead");
      await refuses("INSERT INTO staff_assignments (trip_id, member_id, crew_role) VALUES ($1, $2, 'lead')",
        [trip, staff[1]], /one_open_lead_per_trip/);
    });

    await isolated("up to 4 counselors; the 5th is refused", async () => {
      const trip = await newTrip();
      await assign(trip, staff[0]!, "lead");
      for (const member of staff.slice(1, 4)) await assign(trip, member);
      await refuses("INSERT INTO staff_assignments (trip_id, member_id, crew_role) VALUES ($1, $2, 'counselor')",
        [trip, staff[4]], /at most 4 counselors/);
    });

    await isolated("the same person can't be on one trip twice", async () => {
      const trip = await newTrip();
      await assign(trip, staff[0]!, "lead");
      await refuses("INSERT INTO staff_assignments (trip_id, member_id, crew_role) VALUES ($1, $2, 'counselor')",
        [trip, staff[0]], /one_open_seat_per_member_per_trip/);
    });

    await isolated("a trip won't start with counselors but no lead", async () => {
      const trip = await newTrip();
      await assign(trip, staff[1]!);
      await refuses("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [trip], /requires an assigned active staff member/);
    });

    await isolated("one driver at a time, and a swap keeps the history", async () => {
      const trip = await newTrip();
      await client.query("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)", [trip, driverA]);
      await refuses("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)",
        [trip, driverB], /one_open_driver_per_trip/);
      await client.query("UPDATE trip_driver_assignments SET ended_at = now() WHERE trip_id = $1 AND ended_at IS NULL", [trip]);
      await client.query("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)", [trip, driverB]);
      const history = await client.query(
        "SELECT driver_id, ended_at IS NULL AS open FROM trip_driver_assignments WHERE trip_id = $1 ORDER BY assigned_at, ended_at NULLS LAST",
        [trip]
      );
      assert.equal(history.rowCount, 2);
      assert.deepEqual(history.rows.map((r) => [r.driver_id, r.open]), [[driverA, false], [driverB, true]]);
    });

    await isolated("a retired driver can't be put on a trip", async () => {
      const trip = await newTrip();
      await refuses("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)",
        [trip, retired], /must be active/);
    });

    await isolated("drivers can be swapped while the trip runs, and close when it ends", async () => {
      const trip = await newTrip();
      await assign(trip, staff[0]!, "lead");
      await client.query("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)", [trip, driverA]);
      await client.query("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [trip]);
      await client.query("UPDATE trip_driver_assignments SET ended_at = now() WHERE trip_id = $1 AND ended_at IS NULL", [trip]);
      await client.query("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)", [trip, driverB]);
      await client.query("UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1", [trip]);
      const open = await client.query("SELECT count(*)::int AS n FROM trip_driver_assignments WHERE trip_id = $1 AND ended_at IS NULL", [trip]);
      assert.equal(open.rows[0].n, 0);
      await refuses("INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)",
        [trip, driverA], /planned or running trip/);
    });

    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
});
