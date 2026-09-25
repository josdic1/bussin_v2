import { pool } from "../db/pool.js";

type Coordinate = {
  latitude: number;
  longitude: number;
};

type MapboxDirectionsResponse = {
  code?: string;
  message?: string;
  routes?: Array<{
    distance?: number;
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
  }>;
};

export type StoredRouteGeometry = {
  routeId: string;
  distanceM: number;
  pointCount: number;
};

const MAPBOX_DIRECTIONS_BASE =
  "https://api.mapbox.com/directions/v5/mapbox/driving";
const MAPBOX_MAX_COORDINATES = 25;

function mapboxToken(): string {
  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("Set MAPBOX_ACCESS_TOKEN before generating route geometry.");
  }
  return token;
}

function coordinateChunks(coordinates: Coordinate[]): Coordinate[][] {
  const chunks: Coordinate[][] = [];
  let start = 0;

  while (start < coordinates.length - 1) {
    const end = Math.min(start + MAPBOX_MAX_COORDINATES, coordinates.length);
    chunks.push(coordinates.slice(start, end));
    if (end === coordinates.length) break;
    start = end - 1;
  }

  return chunks;
}

function isLineCoordinates(value: unknown): value is [number, number][] {
  return Array.isArray(value) &&
    value.length >= 2 &&
    value.every((point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      typeof point[0] === "number" &&
      Number.isFinite(point[0]) &&
      typeof point[1] === "number" &&
      Number.isFinite(point[1])
    );
}

async function routeChunk(
  coordinates: Coordinate[],
  token: string
): Promise<{ distanceM: number; coordinates: [number, number][] }> {
  const path = coordinates
    .map(({ longitude, latitude }) => `${longitude},${latitude}`)
    .join(";");

  const url = new URL(`${MAPBOX_DIRECTIONS_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("steps", "false");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000)
  });

  const body = await response.json().catch(() => null) as MapboxDirectionsResponse | null;
  const route = body?.routes?.[0];
  const geometry = route?.geometry;

  if (
    !response.ok ||
    body?.code !== "Ok" ||
    typeof route?.distance !== "number" ||
    !Number.isFinite(route.distance) ||
    route.distance <= 0 ||
    geometry?.type !== "LineString" ||
    !isLineCoordinates(geometry.coordinates)
  ) {
    const detail = body?.message ? ` ${body.message}` : "";
    throw new Error(`Mapbox could not generate this route path.${detail}`);
  }

  return {
    distanceM: route.distance,
    coordinates: geometry.coordinates
  };
}

export async function generateAndStoreRouteGeometry(
  routeId: string
): Promise<StoredRouteGeometry> {
  const stops = await pool.query<Coordinate>(
    `SELECT latitude::double precision AS latitude,
            longitude::double precision AS longitude
       FROM route_stops
      WHERE route_id = $1
      ORDER BY position`,
    [routeId]
  );

  if (stops.rows.length < 2) {
    throw new Error("A route needs at least two located stops to generate a road path.");
  }

  const token = mapboxToken();
  const chunks = coordinateChunks(stops.rows);
  const combinedCoordinates: [number, number][] = [];
  let distanceM = 0;

  for (const [index, chunk] of chunks.entries()) {
    const routed = await routeChunk(chunk, token);
    distanceM += routed.distanceM;
    combinedCoordinates.push(
      ...(index === 0 ? routed.coordinates : routed.coordinates.slice(1))
    );
  }

  const geometry = {
    type: "LineString" as const,
    coordinates: combinedCoordinates
  };

  await pool.query(
    `INSERT INTO route_geometries
       (route_id, geometry, distance_m, provider, profile, generated_at)
     VALUES ($1, $2::jsonb, $3, 'mapbox', 'driving', now())
     ON CONFLICT (route_id) DO UPDATE
       SET geometry = EXCLUDED.geometry,
           distance_m = EXCLUDED.distance_m,
           provider = EXCLUDED.provider,
           profile = EXCLUDED.profile,
           generated_at = EXCLUDED.generated_at`,
    [routeId, JSON.stringify(geometry), distanceM]
  );

  return {
    routeId,
    distanceM,
    pointCount: combinedCoordinates.length
  };
}
