import { hashPassword } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { ADULT_FIRST, fakePhone, KID_FIRST, LAST, pick, slug } from "./names.js";
import { resetDemo } from "./reset.js";

/*
 * Turn a fresh COPY of the camp's database into the demo copy. Run it only against the
 * demo database, right after copying the real one into it:
 *
 *   DEMO_MODE=1 DEMO_TENANT=jcc-demo npm run demo:scrub -w server -- --yes
 *
 * It keeps the setup (lines, stops, times, buses, schedules) and replaces every person:
 * kids, parents, staff, drivers, phones, emails, notes. It wipes all activity and logins,
 * then renames the tenant to DEMO_TENANT. After that the real server refuses to start on
 * this database (wrong tenant), and the demo server refuses to start on the real one.
 * Every login gets the password DEMO_PASSWORD (default "bussin-demo").
 */

const tenant = process.env.DEMO_TENANT ?? "";
if (process.env.DEMO_MODE !== "1" || !process.argv.includes("--yes")) {
  console.error("Refusing: run with DEMO_MODE=1 and --yes, against the demo database only.");
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]{1,34}-demo$/.test(tenant)) {
  console.error('Refusing: set DEMO_TENANT to a key ending in "-demo", for example jcc-demo.');
  process.exit(1);
}

const client = await pool.connect();
try {
  const where = await client.query<{ db: string; host: string | null; key: string; name: string }>(
    `SELECT current_database() AS db, inet_server_addr()::text AS host, tenant_key AS key, display_name AS name
       FROM tenant_identity WHERE singleton = true`);
  const target = where.rows[0];
  if (!target) throw new Error("This database has no tenant. Copy the camp's database into it first.");
  console.log(`Scrubbing database "${target.db}" on ${target.host ?? "local socket"} (tenant ${target.key}, "${target.name}")`);

  await client.query("BEGIN");
  // Logins, phones paired to buses, push subscriptions, and every trace of activity.
  await client.query(`TRUNCATE sessions, invitations, password_reset_tokens, push_sent, push_subscriptions,
    bus_pair_codes, bus_devices, data_edits, staff_presence, family_message_recipients, family_messages, trip_alerts,
    trip_sweeps, trip_rider_events, trip_riders, trip_current_locations, trip_location_samples, trip_events,
    trip_driver_assignments, staff_assignments, trip_stops, trips`);

  // Parents first: each one gets a made-up family name, and their kids share it.
  const guardians = await client.query<{ id: string; memberId: string | null }>(
    `SELECT id, member_id AS "memberId" FROM guardians ORDER BY id`);
  const familyOf = new Map<string, string>();
  let n = 0;
  for (const guardian of guardians.rows) {
    n++;
    const first = pick(ADULT_FIRST, n * 7), last = pick(LAST, n * 3);
    familyOf.set(guardian.id, last);
    const email = `${slug(first)}.${slug(last)}${n}@example.com`;
    await client.query(
      `UPDATE guardians SET name = $2, email = $3, phone = $4, import_dataset = NULL, import_key = NULL WHERE id = $1`,
      [guardian.id, `${first} ${last}`, email, fakePhone(n)]);
    if (guardian.memberId) {
      await client.query(`UPDATE members SET display_name = $2, email = $3, username = NULL, phone = NULL WHERE id = $1`,
        [guardian.memberId, `${first} ${last}`, email]);
    }
  }

  const riders = await client.query<{ id: string; guardianId: string | null }>(
    `SELECT r.id, (SELECT l.guardian_id FROM rider_guardian_links l WHERE l.rider_id = r.id ORDER BY l.guardian_id LIMIT 1) AS "guardianId"
       FROM riders r ORDER BY r.id`);
  n = 0;
  for (const rider of riders.rows) {
    n++;
    const last = (rider.guardianId && familyOf.get(rider.guardianId)) ?? pick(LAST, n * 5);
    await client.query(
      `UPDATE riders SET given_name = $2, family_name = $3, care_notes = NULL,
              emergency_name = $4, emergency_phone = $5, import_dataset = NULL, import_key = NULL WHERE id = $1`,
      [rider.id, pick(KID_FIRST, n * 11), last, `${pick(ADULT_FIRST, n * 13)} ${pick(LAST, n * 17)}`, fakePhone(500 + n)]);
  }

  // Staff and office. Family logins were renamed above with their guardian.
  const staff = await client.query<{ id: string; admin: boolean; username: string | null }>(
    `SELECT m.id, m.username, EXISTS (SELECT 1 FROM member_roles r WHERE r.member_id = m.id AND r.role = 'admin' AND r.revoked_at IS NULL) AS admin
       FROM members m WHERE NOT EXISTS (SELECT 1 FROM guardians g WHERE g.member_id = m.id) ORDER BY m.created_at, m.id`);
  n = 0;
  let offices = 0;
  for (const member of staff.rows) {
    n++;
    if (member.admin) {
      offices++;
      // The built-in "admin" login is locked to that name; every other office login becomes officeN.
      const name = member.username === "admin" ? "admin" : `office${offices}`;
      await client.query(`UPDATE members SET display_name = $2, username = $3, email = $4, phone = $5 WHERE id = $1`,
        [member.id, offices === 1 ? "Camp Office" : `Camp Office ${offices}`, name, `${name}@example.com`, fakePhone(800 + n)]);
    } else {
      const first = pick(ADULT_FIRST, n * 5 + 2), last = pick(LAST, n * 7 + 1);
      await client.query(`UPDATE members SET display_name = $2, username = $3, email = $4, phone = $5 WHERE id = $1`,
        [member.id, `${first} ${last}`, `${slug(first)}_${slug(last)}${n}`.replace(/\./g, "_").slice(0, 32), `${slug(first)}.${slug(last)}${n}@example.com`, fakePhone(700 + n)]);
    }
  }

  // Everyone can sign in with the demo password, and nobody is asked to change it.
  const password = await hashPassword(process.env.DEMO_PASSWORD ?? "bussin-demo");
  await client.query(`UPDATE members SET password_hash = $1, activated_at = COALESCE(activated_at, now()),
                             password_change_required = false, suspended_at = NULL`, [password]);

  const drivers = await client.query<{ id: string }>(`SELECT id FROM drivers ORDER BY created_at, id`);
  n = 0;
  for (const driver of drivers.rows) {
    n++;
    await client.query(`UPDATE drivers SET name = $2, phone = $3 WHERE id = $1`,
      [driver.id, `${pick(ADULT_FIRST, n * 9 + 4)} ${pick(LAST, n * 11 + 6)}`, fakePhone(900 + n)]);
  }
  await client.query(`UPDATE buses SET plate = CASE WHEN plate IS NULL THEN NULL ELSE 'DEMO ' || upper(substr(md5(id::text), 1, 4)) END, notes = NULL`);
  await client.query(`DELETE FROM saved_reports`);

  // The tenant is normally locked for good. This is the one place it changes, on the copy only.
  await client.query(`ALTER TABLE tenant_identity DISABLE TRIGGER tenant_identity_immutable`);
  await client.query(`UPDATE tenant_identity SET tenant_key = $1, display_name = left(display_name, 74) || ' Demo' WHERE singleton = true`, [tenant]);
  await client.query(`ALTER TABLE tenant_identity ENABLE TRIGGER tenant_identity_immutable`);
  const made = await resetDemo(client, "AM");
  await client.query("COMMIT");
  console.log(`Done. Tenant is now ${tenant}. ${guardians.rowCount} parents, ${riders.rowCount} kids, ${staff.rowCount} staff renamed. ${made} morning runs ready.`);
  console.log(`Set BUSSIN_TENANT=${tenant} and DEMO_MODE=1 on the demo server.`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
