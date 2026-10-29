import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { driverInputSchema, driverStatusInputSchema, teamDriverSchema, teamDriversResponseSchema } from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

// Drivers for the Team page. They never sign in: a name and a phone that Dispatch puts on each trip.
// Every change is written to data_edits, the same log the Data page keeps.

export const driverRoutes = Router();
const idSchema = z.string().uuid();

type Row = { id: string; name: string; phone: string | null; active: boolean; upcoming: unknown };

const SELECT = `
  SELECT d.id, d.name, d.phone, d.active,
         coalesce((SELECT json_agg(json_build_object(
                     'tripId', t.id, 'routeName', t.route_name, 'busLabel', b.label,
                     'departureAt', to_json(t.departure_at) #>> '{}') ORDER BY t.departure_at)
                     FROM trip_driver_assignments a
                     JOIN trips t ON t.id = a.trip_id AND t.status IN ('planned', 'active')
                     JOIN buses b ON b.id = t.bus_id
                    WHERE a.driver_id = d.id AND a.ended_at IS NULL
                      AND t.departure_at < now() + interval '7 days'), '[]'::json) AS upcoming
    FROM drivers d`;

async function readDriver(db: PoolClient | typeof pool, id: string) {
  const result = await db.query<Row>(`${SELECT} WHERE d.id = $1`, [id]);
  return result.rows[0] ? teamDriverSchema.parse(result.rows[0]) : null;
}

async function log(client: PoolClient, memberId: string, memberName: string, id: string, column: string, before: string | null, after: string | null) {
  await client.query(
    `INSERT INTO data_edits (member_id, member_name, table_name, row_id, column_name, old_value, new_value)
     VALUES ($1, $2, 'drivers', $3, $4, $5, $6)`, [memberId, memberName, id, column, before, after]);
}

driverRoutes.get("/", requireRole("admin"), async (_request, response) => {
  const result = await pool.query<Row>(`${SELECT} ORDER BY d.active DESC, d.name, d.id`);
  response.json(teamDriversResponseSchema.parse({ drivers: result.rows }));
});

driverRoutes.post("/", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const input = driverInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the driver's details." }); return; }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = (await client.query<{ id: string }>(`INSERT INTO drivers (name, phone) VALUES ($1, $2) RETURNING id`,
      [input.data.name, input.data.phone || null])).rows[0]!.id;
    await log(client, member.id, member.display_name, id, "added", null, input.data.name);
    const driver = await readDriver(client, id);
    await client.query("COMMIT");
    response.status(201).json(driver);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
});

driverRoutes.put("/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = driverInputSchema.safeParse(request.body);
  if (!id.success || !input.success) {
    response.status(400).json({ error: input.success ? "Driver not found." : input.error.issues[0]?.message ?? "Check the driver's details." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = (await client.query<{ name: string; phone: string | null }>(
      `SELECT name, phone FROM drivers WHERE id = $1 FOR UPDATE`, [id.data])).rows[0];
    if (!before) { await client.query("ROLLBACK"); response.status(404).json({ error: "Driver not found." }); return; }
    const phone = input.data.phone || null;
    await client.query(`UPDATE drivers SET name = $2, phone = $3 WHERE id = $1`, [id.data, input.data.name, phone]);
    if (before.name !== input.data.name) await log(client, member.id, member.display_name, id.data, "name", before.name, input.data.name);
    if (before.phone !== phone) await log(client, member.id, member.display_name, id.data, "phone", before.phone, phone);
    const driver = await readDriver(client, id.data);
    await client.query("COMMIT");
    response.json(driver);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
});

/** Retire or bring back. A retired driver keeps their history but can't be put on new trips. */
driverRoutes.post("/:id/status", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = driverStatusInputSchema.safeParse(request.body);
  if (!id.success || !input.success) { response.status(400).json({ error: "Choose a driver." }); return; }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ was: boolean }>(
      `UPDATE drivers d SET active = $2 FROM (SELECT active AS was FROM drivers WHERE id = $1 FOR UPDATE) old
        WHERE d.id = $1 RETURNING old.was`, [id.data, input.data.active]);
    if (!updated.rowCount) { await client.query("ROLLBACK"); response.status(404).json({ error: "Driver not found." }); return; }
    if (updated.rows[0]!.was !== input.data.active) {
      await log(client, member.id, member.display_name, id.data, "status",
        updated.rows[0]!.was ? "Active" : "Retired", input.data.active ? "Active" : "Retired");
    }
    const driver = await readDriver(client, id.data);
    await client.query("COMMIT");
    response.json(driver);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
});
