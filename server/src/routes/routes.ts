import { Router } from "express";
import {
  createRouteSchema,
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
