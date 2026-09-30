import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { resetAllButAdmins, resetCounts } from "./admin/reset.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PGDATABASE;
if (!databaseUrl && !databaseName) {
  throw new Error("Set DATABASE_URL or PGDATABASE before running reset tests");
}
const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 1 } : { database: databaseName, max: 1 });

test("reset removes everything except admin logins, and rolls back cleanly", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tag = randomUUID().slice(0, 8);
    const admin = await client.query<{ id: string }>(
      `INSERT INTO members (username, display_name, password_hash, activated_at, password_change_required)
       VALUES ($1, 'Reset Admin', 'x', now(), false) RETURNING id`, [`reset_admin_${tag}`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'admin')", [admin.rows[0].id]);
    await client.query("INSERT INTO sessions (member_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      [admin.rows[0].id, Buffer.from(tag)]);
    const staff = await client.query<{ id: string }>(
      `INSERT INTO members (username, display_name, password_hash, activated_at, password_change_required)
       VALUES ($1, 'Reset Staff', 'x', now(), false) RETURNING id`, [`reset_staff_${tag}`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [staff.rows[0].id]);
    await client.query("INSERT INTO buses (label, active) VALUES ($1, true)", [`Reset bus ${tag}`]);

    const removed = await resetAllButAdmins(client);
    assert.ok(removed.buses >= 1);
    assert.ok(removed.members >= 1);

    const after = await resetCounts(client);
    assert.deepEqual(
      { buses: after.buses, routes: after.routes, trips: after.trips, riders: after.riders,
        guardians: after.guardians, members: after.members, gpsSamples: after.gpsSamples },
      { buses: 0, routes: 0, trips: 0, riders: 0, guardians: 0, members: 0, gpsSamples: 0 }
    );
    assert.ok(after.keptAdmins >= 1);
    const kept = await client.query("SELECT 1 FROM members WHERE id = $1", [admin.rows[0].id]);
    assert.equal(kept.rowCount, 1, "admin login survives");
    const session = await client.query("SELECT 1 FROM sessions WHERE member_id = $1", [admin.rows[0].id]);
    assert.equal(session.rowCount, 1, "admin stays signed in");
    const gone = await client.query("SELECT 1 FROM members WHERE id = $1", [staff.rows[0].id]);
    assert.equal(gone.rowCount, 0, "staff login removed");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
