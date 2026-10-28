import type { PoolClient } from "pg";
import type { z } from "zod";
import { routeSchema, type createRouteSchema, type Route, type updateRouteSchema } from "@bussin/shared";
import { syncPlannedTripRiders } from "../families/access.js";
import { generateAndStoreRouteGeometry } from "./geometry.js";

// Creating and changing a route, in one place. The Routes page and the CSV import
// both call these, so a route follows the same rules however it is edited.
// The caller owns the transaction; call refreshRouteGeometry after COMMIT.

type CreateRoute = z.infer<typeof createRouteSchema>;
type UpdateRoute = z.infer<typeof updateRouteSchema>;

/** A refusal to show as-is. */
export class RouteSaveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type StopRow = { id: string; position: number; label: string; latitude: number; longitude: number };

const STOP_RETURNING = `RETURNING id, position, label,
  latitude::double precision AS latitude, longitude::double precision AS longitude`;

function databaseCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

export function refreshRouteGeometry(routeId: string): void {
  void generateAndStoreRouteGeometry(routeId).catch((error) => {
    console.error(`Could not refresh geometry for route ${routeId}`, error);
  });
}

export async function resolveRouteFamily(client: PoolClient, familyName: string): Promise<{ id: string; name: string }> {
  const inserted = await client.query<{ id: string; name: string }>(
    `INSERT INTO route_families (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id, name`,
    [familyName]
  );
  if (inserted.rowCount) return inserted.rows[0]!;
  const existing = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM route_families WHERE lower(trim(name)) = lower(trim($1))`, [familyName]
  );
  if (!existing.rowCount) throw new Error("Could not resolve route family");
  return existing.rows[0]!;
}

export async function createRoute(client: PoolClient, input: CreateRoute): Promise<Route> {
  try {
    const family = await resolveRouteFamily(client, input.familyName);
    const previousRevision = await client.query<{ id: string; revision: number }>(
      `SELECT id, revision FROM routes
        WHERE route_family_id = $1 AND service_period = $2
        ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [family.id, input.servicePeriod]
    );
    const revision = previousRevision.rowCount ? previousRevision.rows[0]!.revision + 1 : 1;
    const supersedesRouteId = previousRevision.rowCount ? previousRevision.rows[0]!.id : null;
    const created = await client.query<{ id: string; name: string; servicePeriod: "AM" | "PM"; active: boolean }>(
      `INSERT INTO routes (name, route_family_id, service_period, revision, supersedes_route_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, service_period AS "servicePeriod", active`,
      [input.name, family.id, input.servicePeriod, revision, supersedesRouteId]
    );
    const route: Route = { ...created.rows[0]!, routeFamilyId: family.id, routeFamilyName: family.name, stops: [] };
    for (const [index, stop] of input.stops.entries()) {
      const inserted = await client.query<StopRow>(
        `INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, $2, $3, $4, $5) ${STOP_RETURNING}`,
        [route.id, index + 1, stop.label, stop.latitude, stop.longitude]
      );
      route.stops.push(inserted.rows[0]!);
    }
    return routeSchema.parse(route);
  } catch (error) {
    if (databaseCode(error) === "23505") {
      throw new RouteSaveError(409, `${input.familyName} already has a current ${input.servicePeriod} route.`);
    }
    throw error;
  }
}

/**
 * Unused routes are edited in place. Once a route has trips, saving creates a new
 * revision and leaves the old route and stops untouched for historical trips.
 */
export async function updateRoute(client: PoolClient, id: string, input: UpdateRoute): Promise<Route> {
  try {
    return await updateRouteInner(client, id, input);
  } catch (error) {
    if (databaseCode(error) === "23505") {
      throw new RouteSaveError(409, "That route family already has a current route for this service period.");
    }
    if (databaseCode(error) === "23503") throw new RouteSaveError(409, "A stop is in use and cannot be removed.");
    throw error;
  }
}

async function updateRouteInner(client: PoolClient, id: string, input: UpdateRoute): Promise<Route> {
  const existing = await client.query<{
    id: string; active: boolean; routeFamilyId: string;
    servicePeriod: "AM" | "PM"; revision: number; supersededAt: Date | null;
  }>(
    `SELECT id, active, route_family_id AS "routeFamilyId", service_period AS "servicePeriod",
            revision, superseded_at AS "supersededAt"
       FROM routes WHERE id = $1 FOR UPDATE`, [id]
  );
  const current = existing.rows[0];
  if (!current) throw new RouteSaveError(404, "Route not found.");
  if (current.supersededAt !== null) throw new RouteSaveError(409, "This route revision is historical and cannot be edited.");

  const previous = await client.query<{ id: string; position: number }>(
    "SELECT id, position FROM route_stops WHERE route_id = $1 ORDER BY position FOR UPDATE", [id]
  );
  const known = new Set(previous.rows.map((stop) => stop.id));
  const supplied = input.stops.flatMap((stop) => stop.id ? [stop.id] : []);
  if (new Set(supplied).size !== supplied.length || supplied.some((stopId) => !known.has(stopId))) {
    throw new RouteSaveError(400, "A stop ID is duplicated or belongs to another route.");
  }

  const periodConflict = await client.query(
    `SELECT 1 FROM rider_stop_assignments WHERE route_id = $1 AND direction <> $2 LIMIT 1`,
    [id, input.servicePeriod]
  );
  if (periodConflict.rowCount) {
    throw new RouteSaveError(409, "This route is already assigned to riders in the other service period.");
  }

  const family = await resolveRouteFamily(client, input.familyName);
  const references = await client.query<{ inUse: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM trips WHERE route_id = $1) AS "inUse"`, [id]
  );

  if (references.rows[0]!.inUse) {
    if (family.id !== current.routeFamilyId || input.servicePeriod !== current.servicePeriod) {
      throw new RouteSaveError(409,
        "A used route keeps its route family and AM/PM identity. Create a new route for a different identity.");
    }
    const assignedStops = await client.query<{ routeStopId: string }>(
      `SELECT route_stop_id AS "routeStopId" FROM rider_stop_assignments WHERE route_id = $1`, [id]
    );
    if (assignedStops.rows.some((row) => !supplied.includes(row.routeStopId))) {
      throw new RouteSaveError(409, "A rider or family still uses a stop you removed. Reassign them before revising this route.");
    }

    // Remove the old revision from the current-route slot before inserting its successor.
    await client.query("UPDATE routes SET active = false, superseded_at = now() WHERE id = $1", [id]);
    const created = await client.query<{ id: string; active: boolean }>(
      `INSERT INTO routes (name, route_family_id, service_period, active, revision, supersedes_route_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, active`,
      [input.name, family.id, input.servicePeriod, current.active, current.revision + 1, id]
    );
    const newRouteId = created.rows[0]!.id;
    const stops: Route["stops"] = [];
    const stopMap = new Map<string, string>();
    for (const [index, stop] of input.stops.entries()) {
      const inserted = await client.query<StopRow>(
        `INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, $2, $3, $4, $5) ${STOP_RETURNING}`,
        [newRouteId, index + 1, stop.label, stop.latitude, stop.longitude]
      );
      stops.push(inserted.rows[0]!);
      if (stop.id) stopMap.set(stop.id, inserted.rows[0]!.id);
    }
    for (const [oldStopId, newStopId] of stopMap) {
      await client.query(
        `UPDATE rider_stop_assignments SET route_id = $1, route_stop_id = $2 WHERE route_id = $3 AND route_stop_id = $4`,
        [newRouteId, newStopId, id, oldStopId]
      );
    }
    await syncPlannedTripRiders(client);
    return routeSchema.parse({
      id: newRouteId, name: input.name, routeFamilyId: family.id, routeFamilyName: family.name,
      servicePeriod: input.servicePeriod, active: created.rows[0]!.active, stops
    });
  }

  const offset = Math.max(0, ...previous.rows.map((stop) => stop.position)) + input.stops.length + 1;
  await client.query("UPDATE route_stops SET position = position + $2 WHERE route_id = $1", [id, offset]);
  for (const oldStop of previous.rows) {
    if (!supplied.includes(oldStop.id)) {
      await client.query("DELETE FROM route_stops WHERE id = $1 AND route_id = $2", [oldStop.id, id]);
    }
  }
  await client.query(
    "UPDATE routes SET name = $2, route_family_id = $3, service_period = $4 WHERE id = $1",
    [id, input.name, family.id, input.servicePeriod]
  );
  const stops: Route["stops"] = [];
  for (const [index, stop] of input.stops.entries()) {
    const values = [id, index + 1, stop.label, stop.latitude, stop.longitude];
    const result = stop.id
      ? await client.query<StopRow>(
          `UPDATE route_stops SET position = $2, label = $3, latitude = $4, longitude = $5
            WHERE route_id = $1 AND id = $6 ${STOP_RETURNING}`, [...values, stop.id])
      : await client.query<StopRow>(
          `INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, $2, $3, $4, $5) ${STOP_RETURNING}`,
          values);
    stops.push(result.rows[0]!);
  }
  return routeSchema.parse({
    id, name: input.name, routeFamilyId: family.id, routeFamilyName: family.name,
    servicePeriod: input.servicePeriod, active: current.active, stops
  });
}
