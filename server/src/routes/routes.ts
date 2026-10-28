import { Router } from "express";
import { z } from "zod";
import {
  createRouteSchema,
  updateRouteSchema,
  routesResponseSchema,
  type Route
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { createRoute, refreshRouteGeometry, RouteSaveError, updateRoute } from "./save.js";

export const routeRoutes = Router();


type RouteRow = {
  id: string;
  name: string;
  routeFamilyId: string;
  routeFamilyName: string;
  servicePeriod: "AM" | "PM";
  active: boolean;
  stopId: string | null;
  position: number | null;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
};


routeRoutes.get("/", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<RouteRow>(
    `SELECT r.id, r.name, r.route_family_id AS "routeFamilyId",
            rf.name AS "routeFamilyName", r.service_period AS "servicePeriod", r.active,
            s.id AS "stopId", s.position, s.label,
            s.latitude::double precision AS latitude,
            s.longitude::double precision AS longitude
     FROM routes r
     JOIN route_families rf ON rf.id = r.route_family_id
     LEFT JOIN route_stops s ON s.route_id = r.id
     WHERE r.superseded_at IS NULL
     ORDER BY rf.name, r.service_period, r.id, s.position`
  );

  const routes = new Map<string, Route>();

  for (const row of result.rows) {
    let route = routes.get(row.id);
    if (!route) {
      route = { id: row.id, name: row.name, routeFamilyId: row.routeFamilyId,
        routeFamilyName: row.routeFamilyName, servicePeriod: row.servicePeriod,
        active: row.active, stops: [] };
      routes.set(row.id, route);
    }

    if (row.stopId !== null) {
      if (
        row.position === null || row.label === null ||
        row.latitude === null || row.longitude === null
      ) {
        throw new Error(`Route ${row.id} has a stop without coordinates`);
      }

      route.stops.push({
        id: row.stopId,
        position: row.position,
        label: row.label,
        latitude: row.latitude,
        longitude: row.longitude
      });
    }
  }

  response.json(routesResponseSchema.parse({ routes: [...routes.values()] }));
});

routeRoutes.post("/", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const parsed = createRouteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a route name and stops with valid coordinates" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const route = await createRoute(client, parsed.data);
    await client.query("COMMIT");
    refreshRouteGeometry(route.id);
    response.status(201).json(route);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RouteSaveError) { response.status(error.status).json({ error: error.message }); return; }
    throw error;
  } finally {
    client.release();
  }
});

const routeIdSchema = z.string().uuid();
const statusSchema = z.strictObject({ active: z.boolean() });

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
}


// Unused routes are edited in place; used routes get a new revision (see save.ts).
routeRoutes.put("/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = routeIdSchema.safeParse(request.params.id);
  const input = updateRouteSchema.safeParse(request.body);
  if (!id.success || !input.success) {
    response.status(400).json({ error: "Enter a route name and valid stops." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const route = await updateRoute(client, id.data, input.data);
    await client.query("COMMIT");
    refreshRouteGeometry(route.id);
    response.json(route);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RouteSaveError) { response.status(error.status).json({ error: error.message }); return; }
    throw error;
  } finally {
    client.release();
  }
});

routeRoutes.patch("/:id/status", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = routeIdSchema.safeParse(request.params.id);
  const input = statusSchema.safeParse(request.body);
  if (!id.success || !input.success) {
    response.status(400).json({ error: "Invalid route or status." });
    return;
  }
  const result = await pool.query<{ id: string; active: boolean }>(
    `UPDATE routes SET active = $2
      WHERE id = $1 AND superseded_at IS NULL
      RETURNING id, active`,
    [id.data, input.data.active]
  );
  if (!result.rowCount) {
    response.status(404).json({ error: "Route not found." });
    return;
  }
  response.json(result.rows[0]);
});

routeRoutes.delete("/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = routeIdSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid route ID." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id FROM routes WHERE id = $1 AND superseded_at IS NULL FOR UPDATE",
      [id.data]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Route not found." });
      return;
    }
    await client.query("DELETE FROM route_stops WHERE route_id = $1", [id.data]);
    await client.query("DELETE FROM routes WHERE id = $1", [id.data]);
    await client.query("COMMIT");
    response.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    if (databaseCode(error) === "23503") {
      response.status(409).json({ error: "This route is in use. Deactivate it instead." });
    } else {
      throw error;
    }
  } finally {
    client.release();
  }
});
