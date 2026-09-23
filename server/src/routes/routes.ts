import { Router } from "express";
import { z } from "zod";
import {
  createRouteSchema,
  updateRouteSchema,
  routeSchema,
  routesResponseSchema,
  type Route
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

export const routeRoutes = Router();

type RouteRow = {
  id: string;
  name: string;
  active: boolean;
  stopId: string | null;
  position: number | null;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
};

type StopRow = {
  id: string;
  position: number;
  label: string;
  latitude: number;
  longitude: number;
};

routeRoutes.get("/", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<RouteRow>(
    `SELECT r.id, r.name, r.active,
            s.id AS "stopId", s.position, s.label,
            s.latitude::double precision AS latitude,
            s.longitude::double precision AS longitude
     FROM routes r
     LEFT JOIN route_stops s ON s.route_id = r.id
     ORDER BY r.name, r.id, s.position`
  );

  const routes = new Map<string, Route>();

  for (const row of result.rows) {
    let route = routes.get(row.id);
    if (!route) {
      route = { id: row.id, name: row.name, active: row.active, stops: [] };
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

routeRoutes.post(
  "/",
  requireSameOrigin,
  requireRole("admin"),
  async (request, response) => {
    const parsed = createRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Enter a route name and stops with valid coordinates"
      });
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const created = await client.query<{
        id: string;
        name: string;
        active: boolean;
      }>(
        `INSERT INTO routes (name)
         VALUES ($1)
         RETURNING id, name, active`,
        [parsed.data.name]
      );

      const route: Route = {
        ...created.rows[0],
        stops: []
      };

      for (const [index, stop] of parsed.data.stops.entries()) {
        const inserted = await client.query<StopRow>(
          `INSERT INTO route_stops
             (route_id, position, label, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, position, label,
                     latitude::double precision AS latitude,
                     longitude::double precision AS longitude`,
          [route.id, index + 1, stop.label, stop.latitude, stop.longitude]
        );
        route.stops.push(inserted.rows[0]);
      }

      const output = routeSchema.parse(route);
      await client.query("COMMIT");
      response.status(201).json(output);
    } catch (error) {
      await client.query("ROLLBACK");

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response.status(409).json({ error: "A route with that name already exists" });
        return;
      }

      throw error;
    } finally {
      client.release();
    }
  }
);

const routeIdSchema = z.string().uuid();
const statusSchema = z.strictObject({ active: z.boolean() });

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
}

// Preserve stop IDs during edits: family access and trip records refer to them.
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
    const existing = await client.query<{ id: string; active: boolean }>(
      "SELECT id, active FROM routes WHERE id = $1 FOR UPDATE", [id.data]
    );
    if (!existing.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Route not found." });
      return;
    }
    const references = await client.query<{ inUse: boolean }>(
      `SELECT (EXISTS(SELECT 1 FROM trips WHERE route_id = $1)
            OR EXISTS(SELECT 1 FROM scheduled_runs WHERE route_id = $1)) AS "inUse"`,
      [id.data]
    );
    if (references.rows[0].inUse) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "This route has trips or scheduled runs and cannot be edited." });
      return;
    }
    const previous = await client.query<{ id: string; position: number }>(
      "SELECT id, position FROM route_stops WHERE route_id = $1 FOR UPDATE", [id.data]
    );
    const known = new Set(previous.rows.map((stop) => stop.id));
    const supplied = input.data.stops.flatMap((stop) => stop.id ? [stop.id] : []);
    if (new Set(supplied).size !== supplied.length || supplied.some((stopId) => !known.has(stopId))) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: "A stop ID is duplicated or belongs to another route." });
      return;
    }
    const offset = Math.max(0, ...previous.rows.map((stop) => stop.position)) + input.data.stops.length + 1;
    await client.query("UPDATE route_stops SET position = position + $2 WHERE route_id = $1", [id.data, offset]);
    for (const oldStop of previous.rows) {
      if (!supplied.includes(oldStop.id)) {
        await client.query("DELETE FROM route_stops WHERE id = $1 AND route_id = $2", [oldStop.id, id.data]);
      }
    }
    await client.query("UPDATE routes SET name = $2 WHERE id = $1", [id.data, input.data.name]);
    const stops: Route["stops"] = [];
    for (const [index, stop] of input.data.stops.entries()) {
      const values = [id.data, index + 1, stop.label, stop.latitude, stop.longitude];
      const result = stop.id
        ? await client.query<StopRow>(
            `UPDATE route_stops SET position = $2, label = $3, latitude = $4, longitude = $5
             WHERE route_id = $1 AND id = $6 RETURNING id, position, label,
             latitude::double precision AS latitude, longitude::double precision AS longitude`,
            [...values, stop.id]
          )
        : await client.query<StopRow>(
            `INSERT INTO route_stops (route_id, position, label, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, position, label,
             latitude::double precision AS latitude, longitude::double precision AS longitude`,
            values
          );
      stops.push(result.rows[0]);
    }
    const output = routeSchema.parse({ id: id.data, name: input.data.name,
      active: existing.rows[0].active, stops });
    await client.query("COMMIT");
    response.json(output);
  } catch (error) {
    await client.query("ROLLBACK");
    if (databaseCode(error) === "23505") {
      response.status(409).json({ error: "A route with that name already exists." });
    } else if (databaseCode(error) === "23503") {
      response.status(409).json({ error: "A stop is in use and cannot be removed." });
    } else {
      throw error;
    }
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
    "UPDATE routes SET active = $2 WHERE id = $1 RETURNING id, active", [id.data, input.data.active]
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
    const existing = await client.query("SELECT id FROM routes WHERE id = $1 FOR UPDATE", [id.data]);
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
