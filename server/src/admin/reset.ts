import type { PoolClient } from "pg";
import type { AdminResetCounts } from "@bussin/shared";

/**
 * Everything operational. TRUNCATE runs in the caller's transaction, is all or
 * nothing, and (unlike DELETE) does not fire the append-only row guards on the
 * trip, GPS and check logs. No CASCADE: if a future table points at one of
 * these, the reset fails loudly instead of silently wiping more than intended.
 */
const OPERATIONAL_TABLES = [
  "trip_sweeps",
  "trip_rider_events",
  "trip_riders",
  "trip_current_locations",
  "trip_location_samples",
  "trip_events",
  "staff_assignments",
  "trip_stops",
  "trips",
  "rider_stop_assignments",
  "rider_guardian_links",
  "riders",
  "guardians",
  "route_geometries",
  "route_stops",
  "routes",
  "route_families",
  "buses",
  "staff_presence",
  "invitations",
  "password_reset_tokens"
] as const;

/** Members kept by a reset: anyone holding an active admin role. */
const KEEP_ADMINS = `SELECT member_id FROM member_roles WHERE role = 'admin' AND revoked_at IS NULL`;

export async function resetCounts(client: PoolClient): Promise<AdminResetCounts> {
  const result = await client.query<Record<keyof AdminResetCounts, number>>(
    `SELECT (SELECT count(*) FROM buses)::int AS buses,
            (SELECT count(*) FROM routes)::int AS routes,
            (SELECT count(*) FROM trips)::int AS trips,
            (SELECT count(*) FROM riders)::int AS riders,
            (SELECT count(*) FROM guardians)::int AS guardians,
            (SELECT count(*) FROM members WHERE id NOT IN (${KEEP_ADMINS}))::int AS members,
            (SELECT count(*) FROM trip_location_samples)::int AS "gpsSamples",
            (SELECT count(DISTINCT member_id) FROM member_roles WHERE role = 'admin' AND revoked_at IS NULL)::int AS "keptAdmins"`
  );
  return result.rows[0];
}

/**
 * Deletes every bus, route, trip, rider, guardian and non-admin login. Keeps
 * admin logins (with their sessions, so the admin stays signed in), the
 * tenant identity, and the migration ledger. Returns what was removed.
 */
export async function resetAllButAdmins(client: PoolClient): Promise<AdminResetCounts> {
  await client.query("SELECT pg_advisory_xact_lock(472904)");
  const before = await resetCounts(client);
  if (before.keptAdmins === 0) {
    throw new Error("No active admin login would survive the reset.");
  }

  await client.query(`TRUNCATE ${OPERATIONAL_TABLES.join(", ")}`);
  await client.query(`DELETE FROM sessions WHERE member_id NOT IN (${KEEP_ADMINS})`);
  await client.query(`DELETE FROM member_roles WHERE member_id NOT IN (${KEEP_ADMINS})`);
  const deleted = await client.query(`DELETE FROM members WHERE id NOT IN (${KEEP_ADMINS})`);
  if (deleted.rowCount !== before.members) {
    throw new Error(`Reset stopped: expected to remove ${before.members} logins but removed ${deleted.rowCount ?? 0}. Run db:migrate first.`);
  }
  return before;
}
