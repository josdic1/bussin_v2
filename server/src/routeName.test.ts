import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

// Trips keep the route name they ran under (migration 035).
// A rename reaches planned trips only; running and finished trips keep the old name.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 1 }
  : { database: process.env.PGDATABASE, max: 1 });

test("trips keep their route name", async () => {
  const client = await pool.connect();
  const tag = randomUUID();
  try {
    await client.query("BEGIN");
    const id = async (sql: string, values: unknown[] = []) =>
      (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`rn-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ('Old Name', $1, 'AM')", [family]);
    const other = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ('Other Route', $1, 'PM')", [family]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`RN ${tag}`]);
    const bus2 = await id("INSERT INTO buses (label) VALUES ($1)", [`RN2 ${tag}`]);
    const ran = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, bus]);
    const planned = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now() + interval '1 day')", [route, bus2]);
    const name = async (trip: string) => (await client.query("SELECT route_name FROM trips WHERE id = $1", [trip])).rows[0].route_name;

    assert.equal(await name(ran), "Old Name", "a new trip takes the route's name");
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [ran, lead]);
    await client.query("UPDATE trips SET status = 'active', started_at = now() WHERE id = $1", [ran]);
    await client.query("UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1", [ran]);

    await client.query("UPDATE routes SET name = 'New Name' WHERE id = $1", [route]);
    assert.equal(await name(ran), "Old Name", "a finished trip keeps the old name");
    assert.equal(await name(planned), "New Name", "a planned trip follows the rename");

    await client.query("UPDATE trips SET route_id = $2 WHERE id = $1", [planned, other]);
    assert.equal(await name(planned), "Other Route", "moving a planned trip takes the new route's name");
    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
});
