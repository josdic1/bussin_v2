import { pool } from "../db/pool.js";
import {
  matchGpsToRoute,
  stabilizeRouteProgress,
  type RouteCoordinate,
  type StabilizedRouteProgress
} from "./routeProgress.js";

type GeometryRow = {
  geometry: unknown;
};

type SampleRow = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  observedAt: Date;
};

export type LiveRouteProgress = StabilizedRouteProgress & {
  observedAt: string;
};

function routeCoordinates(geometry: unknown): RouteCoordinate[] {
  if (
    !geometry ||
    typeof geometry !== "object" ||
    !("type" in geometry) ||
    geometry.type !== "LineString" ||
    !("coordinates" in geometry) ||
    !Array.isArray(geometry.coordinates)
  ) {
    throw new Error("Stored route geometry is invalid.");
  }

  const coordinates = geometry.coordinates;

  if (
    coordinates.length < 2 ||
    !coordinates.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        typeof point[0] === "number" &&
        Number.isFinite(point[0]) &&
        typeof point[1] === "number" &&
        Number.isFinite(point[1])
    )
  ) {
    throw new Error("Stored route geometry coordinates are invalid.");
  }

  return coordinates as RouteCoordinate[];
}

export async function readLiveRouteProgress(
  tripId: string
): Promise<LiveRouteProgress | null> {
  const geometryResult = await pool.query<GeometryRow>(
    `SELECT g.geometry
       FROM trips t
       JOIN route_geometries g ON g.route_id = t.route_id
      WHERE t.id = $1
        AND t.status = 'active'`,
    [tripId]
  );

  if (!geometryResult.rowCount) return null;

  const samples = await pool.query<SampleRow>(
    `SELECT
       latitude::double precision AS latitude,
       longitude::double precision AS longitude,
       accuracy_m::double precision AS "accuracyM",
       observed_at AS "observedAt"
     FROM trip_location_samples
     WHERE trip_id = $1
     ORDER BY observed_at`,
    [tripId]
  );

  if (!samples.rowCount) return null;

  const geometry = routeCoordinates(geometryResult.rows[0].geometry);

  let lastGoodDistanceAlongM: number | null = null;
  let latest: LiveRouteProgress | null = null;

  for (const sample of samples.rows) {
    const raw = matchGpsToRoute(geometry, {
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyM: sample.accuracyM
    });

    const stabilized = stabilizeRouteProgress(
      lastGoodDistanceAlongM,
      raw
    );

    // An obviously off-route fix must not redefine known route progress.
    if (!stabilized.offRoute) {
      lastGoodDistanceAlongM = stabilized.distanceAlongM;
    }

    latest = {
      ...stabilized,
      observedAt: sample.observedAt.toISOString()
    };
  }

  return latest;
}
