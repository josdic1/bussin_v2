import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { tripAlertInputSchema, tripAlertLabel } from "@bussin/shared";

// Trip alerts (migration 040): Dispatch and the crew hear a new alert at once; bad input is refused.

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 2 }
  : { database: process.env.PGDATABASE, max: 2 });

test("an emergency from the bus reaches Dispatch and the crew", async () => {
  const listener = await pool.connect();
  const client = await pool.connect();
  const tag = randomUUID();
  const heard: { channel: string; payload: string }[] = [];
  try {
    await listener.query("LISTEN bussin_dispatch_alert");
    await listener.query("LISTEN bussin_staff_trip");
    listener.on("notification", (message) => heard.push({ channel: message.channel, payload: message.payload ?? "" }));
    const id = async (sql: string, values: unknown[] = []) => (await client.query<{ id: string }>(sql + " RETURNING id", values)).rows[0]!.id;
    await client.query("BEGIN");
    const lead = await id("INSERT INTO members (email, display_name) VALUES ($1, 'Lead')", [`${tag}@example.test`]);
    await client.query("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [lead]);
    const family = await id("INSERT INTO route_families (name) VALUES ($1)", [`ta-${tag}`]);
    const route = await id("INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, 'PM')", [`ta-${tag}`, family]);
    const bus = await id("INSERT INTO buses (label) VALUES ($1)", [`TA ${tag}`]);
    const trip = await id("INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, now())", [route, bus]);
    await client.query("INSERT INTO staff_assignments (trip_id, member_id) VALUES ($1, $2)", [trip, lead]);
    await client.query("COMMIT");
    heard.length = 0;

    const alert = await id(
      "INSERT INTO trip_alerts (trip_id, kind, code, note, latitude, longitude, recorded_by) VALUES ($1, 'emergency', 'medical', 'Kid fainted', 40.75, -74.26, $2)",
      [trip, lead]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(heard.some((n) => n.channel === "bussin_dispatch_alert" && n.payload.includes(alert)), "Dispatch hears it");
    assert.ok(heard.some((n) => n.channel === "bussin_staff_trip" && n.payload.includes(lead)), "the crew's phones hear it");

    await assert.rejects(client.query(
      "INSERT INTO trip_alerts (trip_id, kind, code, latitude, recorded_by) VALUES ($1, 'update', 'late_5', 40.7, $2)", [trip, lead]),
      "a half location is refused");
    await assert.rejects(client.query(
      "INSERT INTO trip_alerts (trip_id, kind, code, recorded_by) VALUES ($1, 'panic', 'x', $2)", [trip, lead]), "unknown kind refused");

    assert.equal(tripAlertInputSchema.safeParse({ kind: "update", code: "medical" }).success, false, "codes belong to their kind");
    assert.equal(tripAlertInputSchema.safeParse({ kind: "emergency", code: "medical", latitude: 40.7 }).success, false);
    assert.equal(tripAlertInputSchema.safeParse({ kind: "update", code: "late_10", note: "  " }).data?.note, null);
    assert.equal(tripAlertLabel("emergency", "breakdown"), "Bus broke down");

    await client.query("DELETE FROM trip_alerts WHERE trip_id = $1", [trip]);
    await client.query("DELETE FROM staff_assignments WHERE trip_id = $1", [trip]);
    await client.query("DELETE FROM trips WHERE id = $1", [trip]);
  } finally {
    await listener.query("UNLISTEN *").catch(() => undefined);
    listener.release();
    client.release();
    await pool.end();
  }
});
