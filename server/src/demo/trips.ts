import type { PoolClient } from "pg";

// Demo only: remove whole rides and everything recorded on them. Trip history is normally
// append-only; the guards are lifted for this one transaction and put straight back.

export const TRIP_TABLES = [
  "push_sent", "trip_alerts", "family_message_recipients", "family_messages", "trip_sweeps", "trip_rider_events",
  "trip_riders", "trip_current_locations", "trip_location_samples", "trip_events", "trip_driver_assignments",
  "staff_assignments", "trip_stops", "trips"
];

export async function deleteTrips(client: PoolClient, ids: string[]) {
  if (!ids.length) return 0;
  // Take turns with the regular trip scheduler, which uses this same lock.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('bussin_trip_schedules'))");

  for (const table of TRIP_TABLES) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await client.query(`DELETE FROM family_message_recipients WHERE message_id IN (SELECT id FROM family_messages WHERE trip_id = ANY($1::uuid[]))`, [ids]);
    for (const table of TRIP_TABLES.filter((t) => t !== "trips" && t !== "family_message_recipients")) {
      await client.query(`DELETE FROM ${table} WHERE trip_id = ANY($1::uuid[])`, [ids]);
    }
    const gone = await client.query(`DELETE FROM trips WHERE id = ANY($1::uuid[])`, [ids]);
    return gone.rowCount ?? 0;
  } finally {
    for (const table of TRIP_TABLES) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}
