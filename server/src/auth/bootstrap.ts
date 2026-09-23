import { pool } from "../db/pool.js";
import { hashPassword } from "./sessions.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("The admin/admin starter account is for local setup only");
}

const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(472902)");

  const existing = await client.query(
    `SELECT id FROM members WHERE username = 'admin'`
  );

  if (existing.rowCount !== 0) {
    console.log("System admin already exists; password was not reset");
  } else {
    const passwordHash = await hashPassword("admin");

    const created = await client.query<{ id: string }>(
      `INSERT INTO members
         (username, display_name, password_hash, activated_at,
          password_change_required)
       VALUES ('admin', 'Admin', $1, now(), true)
       RETURNING id`,
      [passwordHash]
    );

    await client.query(
      `INSERT INTO member_roles (member_id, role)
       VALUES ($1, 'admin')`,
      [created.rows[0].id]
    );

    console.log("Created local admin; change the starter password on first login");
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
