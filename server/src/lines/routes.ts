import { Router } from "express";
import { z } from "zod";
import {
  knownPlacesResponseSchema, LINE_COLORS, lineColorInputSchema, lineCreateInputSchema, linesResponseSchema,
  type Line, type LineDirection
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { createRoute, refreshRouteGeometry, RouteSaveError } from "../routes/save.js";
import { buildScheduledTrips } from "../schedules/build.js";
import { readSchedules } from "../schedules/routes.js";

// Lines: one route family = one line. Its current morning and afternoon routes, the
// repeating trips on each, and the kids assigned to it. Creating a line makes both
// routes and both repeating trips in one go, so a shuttle is set up in one form.

export const lineRoutes = Router();
const idSchema = z.string().uuid();

lineRoutes.get("/", requireRole("admin", "dispatch"), async (_request, response) => {
  const [families, routes, stops, kids, schedules] = await Promise.all([
    pool.query<{ id: string; name: string; color: string | null }>(
      `SELECT f.id, f.name, f.color FROM route_families f
        WHERE EXISTS (SELECT 1 FROM routes r WHERE r.route_family_id = f.id AND r.superseded_at IS NULL)
        ORDER BY f.created_at, f.name`),
    pool.query<{ id: string; familyId: string; name: string; servicePeriod: "AM" | "PM"; active: boolean }>(
      `SELECT id, route_family_id AS "familyId", name, service_period AS "servicePeriod", active
         FROM routes WHERE superseded_at IS NULL`),
    pool.query<{ routeId: string; id: string; label: string }>(
      `SELECT s.route_id AS "routeId", s.id, s.label FROM route_stops s
         JOIN routes r ON r.id = s.route_id AND r.superseded_at IS NULL ORDER BY s.route_id, s.position`),
    pool.query<{ familyId: string; kids: number; partWeek: number }>(
      `SELECT r.route_family_id AS "familyId", count(DISTINCT a.rider_id)::int AS kids,
              count(DISTINCT a.rider_id) FILTER (WHERE x.ride_days IS NOT NULL)::int AS "partWeek"
         FROM rider_stop_assignments a JOIN routes r ON r.id = a.route_id JOIN riders x ON x.id = a.rider_id
        GROUP BY r.route_family_id`),
    readSchedules(pool)
  ]);

  const stopsByRoute = new Map<string, { id: string; label: string }[]>();
  for (const stop of stops.rows) stopsByRoute.set(stop.routeId, [...(stopsByRoute.get(stop.routeId) ?? []), { id: stop.id, label: stop.label }]);
  const kidsByFamily = new Map(kids.rows.map((row) => [row.familyId, row]));

  const lines: Line[] = families.rows.map((family, index) => {
    const direction = (period: "AM" | "PM"): LineDirection | null => {
      const route = routes.rows.find((r) => r.familyId === family.id && r.servicePeriod === period);
      if (!route) return null;
      return {
        routeId: route.id, routeName: route.name, active: route.active,
        stops: stopsByRoute.get(route.id) ?? [],
        schedules: schedules.filter((s) => s.routeId === route.id && !s.stoppedAt)
      };
    };
    return {
      id: family.id, name: family.name,
      color: family.color ?? LINE_COLORS[index % LINE_COLORS.length]!,
      am: direction("AM"), pm: direction("PM"),
      kids: kidsByFamily.get(family.id)?.kids ?? 0,
      partWeek: kidsByFamily.get(family.id)?.partWeek ?? 0
    };
  });
  response.json(linesResponseSchema.parse({ lines }));
});

/** Places already on a route: pick JCC or Camp from a list instead of typing coordinates again. */
lineRoutes.get("/places", requireRole("admin", "dispatch"), async (_request, response) => {
  const places = await pool.query<{ label: string; latitude: number; longitude: number }>(
    `SELECT DISTINCT ON (lower(s.label)) s.label, s.latitude::double precision AS latitude, s.longitude::double precision AS longitude
       FROM route_stops s JOIN routes r ON r.id = s.route_id AND r.superseded_at IS NULL
      WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      ORDER BY lower(s.label), r.created_at DESC`);
  response.json(knownPlacesResponseSchema.parse({ places: places.rows }));
});

/** A new shuttle line: both routes and both repeating trips, built in one transaction. */
lineRoutes.post("/", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const input = lineCreateInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the line." }); return; }
  const line = input.data;
  const client = await pool.connect();
  const routeIds: string[] = [];
  try {
    await client.query("BEGIN");
    // A name with no routes yet (an empty starter family) is free to use.
    const taken = await client.query(
      `SELECT 1 FROM route_families f WHERE lower(trim(f.name)) = lower(trim($1))
          AND EXISTS (SELECT 1 FROM routes r WHERE r.route_family_id = f.id AND r.superseded_at IS NULL)`, [line.name]);
    if (taken.rowCount) { await client.query("ROLLBACK"); response.status(409).json({ error: `There's already a line called ${line.name}.` }); return; }
    const bus = await client.query("SELECT 1 FROM buses WHERE id = $1 AND active", [line.busId]);
    if (!bus.rowCount) { await client.query("ROLLBACK"); response.status(409).json({ error: "That bus is out of service. Pick another one." }); return; }

    const am = await createRoute(client, { name: `${line.name} AM`, familyName: line.name, servicePeriod: "AM", stops: [line.from, line.to] });
    const pm = await createRoute(client, { name: `${line.name} PM`, familyName: line.name, servicePeriod: "PM", stops: [line.to, line.from] });
    routeIds.push(am.id, pm.id);
    // An empty starter family reused here takes the name exactly as typed.
    await client.query("UPDATE route_families SET color = $2, name = $3 WHERE id = $1", [am.routeFamilyId, line.color, line.name]);

    let built = 0;
    const skipped: { day: string; reason: string }[] = [];
    for (const [routeId, time] of [[am.id, line.morningTime], [pm.id, line.afternoonTime]] as const) {
      if (!time) continue;
      const created = await client.query<{ id: string }>(
        `INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, lead_id, counselor_ids, driver_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [routeId, line.busId, line.weekdays, time, line.startsOn, line.endsOn,
          line.crew.leadId, line.crew.counselorIds, line.crew.driverId, currentMember(response).id]);
      const result = await buildScheduledTrips(client, created.rows[0]!.id);
      built += result.built;
      skipped.push(...result.skipped.map(({ day, reason }) => ({ day, reason })));
    }
    await client.query("COMMIT");
    for (const id of routeIds) refreshRouteGeometry(id);
    response.status(201).json({ id: am.routeFamilyId, built, skipped });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RouteSaveError) { response.status(error.status).json({ error: error.message }); return; }
    throw error;
  } finally {
    client.release();
  }
});

lineRoutes.patch("/:id/color", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = lineColorInputSchema.safeParse(request.body);
  if (!id.success || !input.success) { response.status(400).json({ error: "Pick a color." }); return; }
  const updated = await pool.query("UPDATE route_families SET color = $2 WHERE id = $1", [id.data, input.data.color]);
  if (!updated.rowCount) { response.status(404).json({ error: "Line not found." }); return; }
  response.status(204).end();
});
