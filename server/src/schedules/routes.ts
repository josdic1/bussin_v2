import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  tripScheduleInputSchema, tripScheduleSaveResponseSchema, tripScheduleSchema, tripSchedulesResponseSchema,
  type TripScheduleInput
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { buildScheduledTrips, CURRENT_ROUTE, removeUntouchedTrips } from "./build.js";

// Timetable: repeating trips. Saving one builds its next two weeks of trips at once.
// Changing or stopping one takes back the future trips it built that nobody has touched.

export const scheduleRoutes = Router();
const idSchema = z.string().uuid();

type Row = {
  id: string; routeId: string; routeName: string; servicePeriod: "AM" | "PM"; routeUsable: boolean;
  busId: string; busLabel: string; weekdays: number[]; departTime: string; startsOn: string; endsOn: string;
  leadId: string | null; leadName: string | null; leadPhone: string | null; driverId: string | null; driverName: string | null; driverPhone: string | null;
  counselors: { id: string; displayName: string }[] | null; stoppedAt: Date | null; upcoming: number; nextDepartureAt: Date | null;
};

export async function readSchedules(db: Pick<PoolClient, "query">, id?: string) {
  const result = await db.query<Row>(
    `SELECT s.id, cur.id AS "routeId", cur.name AS "routeName", cur.service_period AS "servicePeriod",
            (cur.active AND cur.superseded_at IS NULL) AS "routeUsable",
            s.bus_id AS "busId", b.label AS "busLabel", s.weekdays::int[] AS weekdays,
            to_char(s.depart_time, 'HH24:MI') AS "departTime",
            to_char(s.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(s.ends_on, 'YYYY-MM-DD') AS "endsOn",
            s.lead_id AS "leadId", lead.display_name AS "leadName", lead.phone AS "leadPhone",
            s.driver_id AS "driverId", d.name AS "driverName", d.phone AS "driverPhone",
            (SELECT json_agg(json_build_object('id', m.id, 'displayName', m.display_name) ORDER BY array_position(s.counselor_ids, m.id))
               FROM members m WHERE m.id = ANY (s.counselor_ids)) AS counselors,
            s.stopped_at AS "stoppedAt",
            (SELECT count(*)::int FROM trips t WHERE t.schedule_id = s.id AND t.status = 'planned' AND t.departure_at > now()) AS upcoming,
            (SELECT min(t.departure_at) FROM trips t WHERE t.schedule_id = s.id AND t.status = 'planned' AND t.departure_at > now()) AS "nextDepartureAt"
       FROM trip_schedules s
       JOIN LATERAL (
         WITH RECURSIVE chain AS (
           SELECT r.* FROM routes r WHERE r.id = s.route_id
           UNION ALL
           SELECT n.* FROM routes n JOIN chain c ON n.supersedes_route_id = c.id
         )
         SELECT * FROM chain ORDER BY (superseded_at IS NULL) DESC, revision DESC LIMIT 1
       ) cur ON true
       JOIN buses b ON b.id = s.bus_id
       LEFT JOIN members lead ON lead.id = s.lead_id
       LEFT JOIN drivers d ON d.id = s.driver_id
      WHERE ($1::uuid IS NULL OR s.id = $1)
      ORDER BY (s.stopped_at IS NULL) DESC, cur.service_period, s.depart_time, b.label, s.id`,
    [id ?? null]
  );
  return result.rows.map((row) => tripScheduleSchema.parse({
    id: row.id, routeId: row.routeId, routeName: row.routeName, servicePeriod: row.servicePeriod, routeUsable: row.routeUsable,
    busId: row.busId, busLabel: row.busLabel, weekdays: row.weekdays, departTime: row.departTime,
    startsOn: row.startsOn, endsOn: row.endsOn,
    lead: row.leadId ? { id: row.leadId, displayName: row.leadName ?? "Staff", phone: row.leadPhone } : null,
    counselors: row.counselors ?? [],
    driver: row.driverId ? { id: row.driverId, name: row.driverName ?? "Driver", phone: row.driverPhone } : null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    upcoming: row.upcoming, nextDepartureAt: row.nextDepartureAt?.toISOString() ?? null
  }));
}

/** Refuse a schedule whose route, bus or crew can't work, in words the office understands. */
export async function problemWith(client: PoolClient, input: TripScheduleInput): Promise<string | null> {
  const route = await client.query<{ id: string; active: boolean }>(CURRENT_ROUTE, [input.routeId]);
  if (!route.rows[0]?.active) return "That route is turned off. Pick another one.";
  const bus = await client.query("SELECT 1 FROM buses WHERE id = $1 AND active", [input.busId]);
  if (!bus.rowCount) return "That bus is out of service. Pick another one.";
  const people = [input.crew.leadId, ...input.crew.counselorIds].filter((id): id is string => !!id);
  if (people.length) {
    const ok = await client.query(
      `SELECT m.id FROM members m
         JOIN member_roles r ON r.member_id = m.id AND r.role = 'staff' AND r.revoked_at IS NULL
        WHERE m.id = ANY($1::uuid[]) AND m.suspended_at IS NULL`, [people]);
    if (ok.rowCount !== people.length) return "Pick active counselors for the crew.";
  }
  if (input.crew.driverId) {
    const driver = await client.query("SELECT 1 FROM drivers WHERE id = $1 AND active", [input.crew.driverId]);
    if (!driver.rowCount) return "Pick an active driver.";
  }
  return null;
}

async function respond(client: PoolClient, id: string, built: { built: number; skipped: { day: string; reason: string }[] }, removed: number) {
  const [schedule] = await readSchedules(client, id);
  return tripScheduleSaveResponseSchema.parse({
    schedule, built: built.built, removed,
    skipped: built.skipped.map(({ day, reason }) => ({ day, reason }))
  });
}

scheduleRoutes.get("/", requireRole("admin", "dispatch"), async (_request, response) => {
  response.json(tripSchedulesResponseSchema.parse({ schedules: await readSchedules(pool) }));
});

scheduleRoutes.post("/", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const input = tripScheduleInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the repeating trip." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const problem = await problemWith(client, input.data);
    if (problem) { await client.query("ROLLBACK"); response.status(409).json({ error: problem }); return; }
    const created = await client.query<{ id: string }>(
      `INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, lead_id, counselor_ids, driver_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.data.routeId, input.data.busId, input.data.weekdays, input.data.departTime, input.data.startsOn, input.data.endsOn,
        input.data.crew.leadId, input.data.crew.counselorIds, input.data.crew.driverId, currentMember(response).id]);
    const id = created.rows[0]!.id;
    const built = await buildScheduledTrips(client, id);
    const body = await respond(client, id, built, 0);
    await client.query("COMMIT");
    response.status(201).json(body);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

scheduleRoutes.put("/:id", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = tripScheduleInputSchema.safeParse(request.body);
  if (!id.success) { response.status(400).json({ error: "Choose a repeating trip." }); return; }
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the repeating trip." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ stopped: boolean }>(
      "SELECT stopped_at IS NOT NULL AS stopped FROM trip_schedules WHERE id = $1 FOR UPDATE", [id.data]);
    if (!current.rowCount) { await client.query("ROLLBACK"); response.status(404).json({ error: "Repeating trip not found." }); return; }
    if (current.rows[0]!.stopped) { await client.query("ROLLBACK"); response.status(409).json({ error: "This one is stopped. Add a new repeating trip instead." }); return; }
    const problem = await problemWith(client, input.data);
    if (problem) { await client.query("ROLLBACK"); response.status(409).json({ error: problem }); return; }
    const removed = await removeUntouchedTrips(client, id.data);
    await client.query(
      `UPDATE trip_schedules SET route_id = $2, bus_id = $3, weekdays = $4, depart_time = $5, starts_on = $6, ends_on = $7,
              lead_id = $8, counselor_ids = $9, driver_id = $10, updated_at = now()
        WHERE id = $1`,
      [id.data, input.data.routeId, input.data.busId, input.data.weekdays, input.data.departTime, input.data.startsOn,
        input.data.endsOn, input.data.crew.leadId, input.data.crew.counselorIds, input.data.crew.driverId]);
    const built = await buildScheduledTrips(client, id.data);
    const body = await respond(client, id.data, built, removed);
    await client.query("COMMIT");
    response.json(body);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

/** Stop repeating. Trips already run stay in the record; untouched future ones are taken back. */
scheduleRoutes.post("/:id/stop", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a repeating trip." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stopped = await client.query(
      "UPDATE trip_schedules SET stopped_at = now(), updated_at = now() WHERE id = $1 AND stopped_at IS NULL", [id.data]);
    if (!stopped.rowCount) {
      await client.query("ROLLBACK");
      const exists = await pool.query("SELECT 1 FROM trip_schedules WHERE id = $1", [id.data]);
      response.status(exists.rowCount ? 409 : 404).json({ error: exists.rowCount ? "Already stopped." : "Repeating trip not found." });
      return;
    }
    const removed = await removeUntouchedTrips(client, id.data);
    const body = await respond(client, id.data, { built: 0, skipped: [] }, removed);
    await client.query("COMMIT");
    response.json(body);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});
