import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { hashSecret } from "./device/auth.js";

// Bus tracker rules (migration 034), checked straight against the database:
//   one paired phone per bus, a tracker only reports for a running trip on its own bus,
//   an unpaired tracker is refused, and every GPS fix has exactly one sender.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 1 }
  : { database: process.env.PGDATABASE, max: 1 });

test("bus tracker rules", async (t) => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;

    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`dev-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'AM')", [`dev-${tag}`, family]);
    const busA = await id("INSERT INTO buses (label) VALUES ($1)", [`Dev A ${tag}`]);
    const busB = await id("INSERT INTO buses (label) VALUES ($1)", [`Dev B ${tag}`]);
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, busA]);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, lead]);
    await client.query("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [trip]);
    const pair = (bus: string) => id("INSERT INTO bus_devices (bus_id, token_hash) VALUES ($1, $2)", [bus, hashSecret(randomUUID())]);

    let sequence = 0;
    async function isolated(name: string, run: () => Promise<void>) {
      await t.test(name, async () => {
        const savepoint = `device_test_${++sequence}`;
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
    const sample = (member: string | null, device: string | null) => client.query(
      `INSERT INTO trip_location_samples (trip_id, member_id, device_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
       VALUES ($1, $2, $3, $4, now(), 40.7, -74.2, 10)`,
      [trip, member, device, randomUUID()]
    );
    const sampleSql = `INSERT INTO trip_location_samples (trip_id, member_id, device_id, client_sample_id, observed_at, latitude, longitude, accuracy_m)
       VALUES ($1, $2, $3, $4, now(), 40.7, -74.2, 10)`;

    await isolated("the bus's tracker reports for its running trip and moves the bus on the map", async () => {
      const device = await pair(busA);
      await sample(null, device);
      const current = await client.query(
        "SELECT s.device_id FROM trip_current_locations c JOIN trip_location_samples s ON s.id = c.sample_id WHERE c.trip_id = $1",
        [trip]
      );
      assert.equal(current.rows[0]?.device_id, device);
    });

    await isolated("another bus's tracker is refused", async () => {
      const other = await pair(busB);
      await refuses(sampleSql, [trip, null, other, randomUUID()], /not the tracker for this bus/);
    });

    await isolated("an unpaired tracker is refused", async () => {
      const device = await pair(busA);
      await client.query("UPDATE bus_devices SET revoked_at = now() WHERE id = $1", [device]);
      await refuses(sampleSql, [trip, null, device, randomUUID()], /not the tracker for this bus/);
    });

    await isolated("one paired phone per bus", async () => {
      await pair(busA);
      await refuses("INSERT INTO bus_devices (bus_id, token_hash) VALUES ($1, $2)", [busA, hashSecret(randomUUID())], /one_active_device_per_bus/);
    });

    await isolated("a fix has exactly one sender", async () => {
      const device = await pair(busA);
      await refuses(sampleSql, [trip, lead, device, randomUUID()], /trip_location_samples_one_sender/);
      await refuses(sampleSql, [trip, null, null, randomUUID()], /one_sender|not assigned to this trip/);
    });

    await isolated("staff phones still report as before", async () => {
      await sample(lead, null);
      const count = await client.query("SELECT count(*)::int AS n FROM trip_location_samples WHERE trip_id = $1", [trip]);
      assert.equal(count.rows[0].n, 1);
    });

    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
});
