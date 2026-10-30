import type { PoolClient } from "pg";
import { resetDemo } from "./reset.js";
import { deleteTrips } from "./trips.js";

/*
 * Demo only. Wipe parts of the demo camp and keep the rest. The admin login is always kept.
 *
 * What depends on what (the database enforces this, so the rules below follow it):
 *  - Trips and everything on them (GPS, checks, messages about a trip) point at the
 *    buses, routes, kids and team. Remove any of those and the trips go too.
 *  - Messages point at trips and parents, so they go whenever trips or kids go.
 *  - If the setup and team survive but trips don't, the schedule rebuilds today's run
 *    and the next two weeks, so the camp is ready to use straight away.
 */

export type Keep = { setup: boolean; team: boolean; kids: boolean; history: boolean; messages: boolean };

const TRIPS = [
  "push_sent", "trip_alerts", "family_message_recipients", "family_messages", "trip_sweeps", "trip_rider_events",
  "trip_riders", "trip_current_locations", "trip_location_samples", "trip_events", "trip_driver_assignments",
  "staff_assignments", "trip_stops", "trips", "data_edits"
];
const ADMINS = `SELECT member_id FROM member_roles WHERE role = 'admin' AND revoked_at IS NULL`;

/** What actually survives once the dependencies are applied. */
export function effectiveKeep(keep: Keep): Keep {
  const history = keep.history && keep.setup && keep.team && keep.kids;
  return { ...keep, history, messages: keep.messages && history && keep.kids };
}

export async function clearDemo(client: PoolClient, asked: Keep) {
  const keep = effectiveKeep(asked);
  if (!keep.history) await client.query(`TRUNCATE ${TRIPS.join(", ")}`);
  else if (!keep.messages) await client.query(`TRUNCATE family_message_recipients, family_messages, trip_alerts`);

  if (!keep.setup) {
    // TRUNCATE has to name every table pointing at these; the trip tables are already empty here.
    await client.query(`TRUNCATE ${[...TRIPS, "bus_pair_codes", "bus_devices", "rider_stop_assignments", "trip_schedules",
      "route_geometries", "route_stops", "routes", "route_families", "buses"].join(", ")}`);
  }
  if (!keep.kids) {
    // Parents' logins go with them; the admin never does.
    await client.query(`CREATE TEMP TABLE demo_family ON COMMIT DROP AS
      SELECT g.member_id AS id FROM guardians g WHERE g.member_id IS NOT NULL AND g.member_id NOT IN (${ADMINS})`);
    await client.query(`TRUNCATE ${[...TRIPS, "rider_stop_assignments", "rider_guardian_links", "riders", "guardians"].join(", ")}`);
    await removeMembers(client, "SELECT id FROM demo_family");
  }
  if (!keep.team) {
    if (keep.setup) await client.query(`UPDATE trip_schedules SET lead_id = NULL, counselor_ids = '{}', driver_id = NULL`);
    await client.query(`DELETE FROM drivers`);
    await removeMembers(client, `SELECT m.id FROM members m
      WHERE m.id NOT IN (${ADMINS}) AND NOT EXISTS (SELECT 1 FROM guardians g WHERE g.member_id = m.id)`);
  }

  // Trips gone but there is still a camp to run: put today's run and the next two weeks back.
  const runs = !keep.history && keep.setup ? await resetDemo(client, "AM") : 0;
  return { kept: keep, runs };
}

/** Every place a login is pointed at, outside the trip tables (those are already empty when people go). */
const MEMBER_LINKS: [string, string][] = [
  ["sessions", "member_id"], ["member_roles", "member_id"], ["invitations", "invited_by"], ["invitations", "accepted_by"],
  ["password_reset_tokens", "member_id"], ["staff_presence", "member_id"], ["push_subscriptions", "member_id"],
  ["push_sent", "member_id"], ["saved_reports", "created_by"], ["bus_devices", "paired_by"], ["bus_pair_codes", "created_by"]
];

async function removeMembers(client: PoolClient, which: string) {
  await client.query(`UPDATE guardians SET member_id = NULL WHERE member_id IN (${which}) AND member_id NOT IN (${ADMINS})`);
  for (const [table, column] of MEMBER_LINKS) {
    await client.query(`DELETE FROM ${table} WHERE ${column} IN (${which}) AND ${column} NOT IN (${ADMINS})`);
  }
  await client.query(`DELETE FROM members WHERE id IN (${which}) AND id NOT IN (${ADMINS})`);
}

/** Delete one ride and everything recorded on it. */
export async function deleteRide(client: PoolClient, tripId: string) {
  return (await deleteTrips(client, [tripId])) > 0;
}
