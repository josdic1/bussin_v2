import { hashPassword } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { DEMO_REQUESTED, isDemoTenant } from "./mode.js";
import { refreshRouteGeometry } from "../routes/save.js";

/**
 * First start of a brand-new demo server: the database is empty, so claim it as the demo
 * camp and make the admin login. Does nothing unless DEMO_MODE=1, the tenant name ends in
 * "-demo", and the database has never been claimed. The real server never gets here.
 */
export async function prepareDemoDatabase() {
  const key = process.env.BUSSIN_TENANT ?? "";
  if (!DEMO_REQUESTED || !isDemoTenant(key)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(472903)");
    const claimed = await client.query("SELECT 1 FROM tenant_identity");
    if (claimed.rowCount) { await client.query("ROLLBACK"); return; }
    const used = await client.query<{ n: number }>(`SELECT ((SELECT count(*) FROM buses) + (SELECT count(*) FROM members))::int AS n`);
    if (used.rows[0]!.n > 0) throw new Error("Refusing to set up the demo: this database already has data in it.");
    await client.query(`INSERT INTO tenant_identity (tenant_key, display_name) VALUES ($1, 'Demo Camp')`, [key]);
    const admin = await client.query<{ id: string }>(
      `INSERT INTO members (username, display_name, email, password_hash, activated_at, password_change_required)
       VALUES ('admin', 'Camp Office', 'office@example.com', $1, now(), false) RETURNING id`,
      [await hashPassword(process.env.DEMO_PASSWORD ?? "bussin-demo")]);
    await client.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, 'admin')`, [admin.rows[0]!.id]);
    await client.query("COMMIT");
    console.log(`Demo database set up as ${key}. Open the site to build a camp.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Draw the road shape for any route that doesn't have one yet (for example, built before the map key was set). */
export async function fillRouteShapes() {
  if (!process.env.MAPBOX_ACCESS_TOKEN) return;
  const missing = await pool.query<{ id: string }>(
    `SELECT r.id FROM routes r WHERE r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM route_geometries g WHERE g.route_id = r.id)`);
  for (const row of missing.rows) refreshRouteGeometry(row.id);
  if (missing.rowCount) console.log(`Drawing road shapes for ${missing.rowCount} routes.`);
}
