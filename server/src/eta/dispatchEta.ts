import { boardEtaSchema } from "@bussin/shared";
import { pool } from "../db/pool.js";
import { dwellBeforeStopSeconds } from "./dwell.js";
import { etaAvailability } from "./freshness.js";
import { readLivePace, travelSecondsFromLivePace } from "./livePace.js";
import {
  readLiveRouteProgress,
  routeCoordinates
} from "./liveProgress.js";
import { matchGpsToRoute } from "./routeProgress.js";
import { buildTrafficStopEtas } from "./stopEtas.js";
import {
  readTrafficTravelTime,
  type TrafficTravelTime
} from "./traffic.js";

type StateRow = {
  status: string;
  latitude: number | null;
  longitude: number | null;
  observedAt: Date | null;
  geometry: unknown;
};

type StopRow = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  arrivedAt: Date | null;
  departedAt: Date | null;
};

type TrafficCacheEntry = {
  expiresAt: number;
  generatedAt: string;
  value: TrafficTravelTime | null;
};

const TRAFFIC_CACHE_MS = 45_000;
const TRAFFIC_FAILURE_CACHE_MS = 10_000;
const trafficCache = new Map<string, TrafficCacheEntry>();

async function cachedTraffic(
  tripId: string,
  current: { latitude: number; longitude: number },
  stops: StopRow[]
): Promise<TrafficCacheEntry> {
  const stopState = stops.map((stop) =>
    `${stop.id}:${stop.arrivedAt?.toISOString() ?? ""}:${stop.departedAt?.toISOString() ?? ""}`
  ).join(",");
  const key = `${tripId}:${stopState}`;
  const now = Date.now();
  const cached = trafficCache.get(key);

  if (cached && cached.expiresAt > now) return cached;

  let value: TrafficTravelTime | null = null;

  try {
    value = await readTrafficTravelTime(current, stops);
  } catch {
    value = null;
  }

  const entry = {
    value,
    generatedAt: new Date(now).toISOString(),
    expiresAt: now + (value ? TRAFFIC_CACHE_MS : TRAFFIC_FAILURE_CACHE_MS)
  };

  trafficCache.set(key, entry);
  return entry;
}

export async function buildDispatchEta(tripId: string) {
  const stateResult = await pool.query<StateRow>(
    `SELECT
       t.status,
       sample.latitude::double precision AS latitude,
       sample.longitude::double precision AS longitude,
       sample.observed_at AS "observedAt",
       g.geometry
     FROM trips t
     LEFT JOIN trip_current_locations current_location
       ON current_location.trip_id = t.id
     LEFT JOIN trip_location_samples sample
       ON sample.id = current_location.sample_id
     LEFT JOIN route_geometries g
       ON g.route_id = t.route_id
     WHERE t.id = $1`,
    [tripId]
  );

  if (!stateResult.rowCount || stateResult.rows[0].status !== "active") {
    return null;
  }

  const state = stateResult.rows[0];

  if (
    state.latitude === null ||
    state.longitude === null ||
    state.observedAt === null
  ) {
    return boardEtaSchema.parse({
      status: "calculating",
      source: null,
      generatedAt: null,
      stops: []
    });
  }

  const progress = await readLiveRouteProgress(tripId);

  if (!progress) {
    return boardEtaSchema.parse({
      status: "unavailable",
      source: null,
      generatedAt: null,
      stops: []
    });
  }

  const availability = etaAvailability(
    progress.observedAt,
    progress.offRoute
  );

  if (!availability.available) {
    return boardEtaSchema.parse({
      status: availability.freshness,
      source: null,
      generatedAt: null,
      stops: []
    });
  }

  const stopsResult = await pool.query<StopRow>(
    `SELECT
       ts.id,
       ts.label,
       ts.latitude::double precision AS latitude,
       ts.longitude::double precision AS longitude,
       arrived.occurred_at AS "arrivedAt",
       departed.occurred_at AS "departedAt"
     FROM trip_stops ts
     LEFT JOIN LATERAL (
       SELECT e.occurred_at
       FROM trip_events e
       WHERE e.trip_id = ts.trip_id
         AND e.trip_stop_id = ts.id
         AND e.event_type = 'arrived_stop'
         AND NOT EXISTS (
           SELECT 1 FROM trip_events correction
           WHERE correction.replaces_event_id = e.id
         )
       ORDER BY e.occurred_at DESC
       LIMIT 1
     ) arrived ON true
     LEFT JOIN LATERAL (
       SELECT e.occurred_at
       FROM trip_events e
       WHERE e.trip_id = ts.trip_id
         AND e.trip_stop_id = ts.id
         AND e.event_type = 'departed_stop'
         AND NOT EXISTS (
           SELECT 1 FROM trip_events correction
           WHERE correction.replaces_event_id = e.id
         )
       ORDER BY e.occurred_at DESC
       LIMIT 1
     ) departed ON true
     WHERE ts.trip_id = $1
       AND departed.occurred_at IS NULL
     ORDER BY ts.position`,
    [tripId]
  );

  const stops = stopsResult.rows;

  if (!stops.length) {
    return boardEtaSchema.parse({
      status: availability.freshness,
      source: null,
      generatedAt: new Date().toISOString(),
      stops: []
    });
  }

  const traffic = await cachedTraffic(
    tripId,
    { latitude: state.latitude, longitude: state.longitude },
    stops
  );

  const etaStops = stops.map((stop) => ({
    id: stop.id,
    label: stop.label,
    arrivedAt: stop.arrivedAt?.toISOString() ?? null,
    departedAt: stop.departedAt?.toISOString() ?? null
  }));

  if (traffic.value) {
    return boardEtaSchema.parse({
      status: availability.freshness,
      source: "mapbox-traffic",
      generatedAt: traffic.generatedAt,
      stops: buildTrafficStopEtas(
        etaStops,
        traffic.value.legs,
        Date.parse(traffic.generatedAt)
      )
    });
  }

  const pace = await readLivePace(tripId);

  if (!pace || state.geometry === null) {
    return boardEtaSchema.parse({
      status: "unavailable",
      source: null,
      generatedAt: null,
      stops: []
    });
  }

  const geometry = routeCoordinates(state.geometry);
  const nowMs = Date.now();
  const fallbackStops = [];

  for (const [index, stop] of stops.entries()) {
    if (stop.arrivedAt && !stop.departedAt) {
      fallbackStops.push({
        stopId: stop.id,
        label: stop.label,
        etaAt: stop.arrivedAt.toISOString(),
        durationSecondsFromNow: 0,
        distanceMFromNow: 0,
        actualArrival: true
      });
      continue;
    }

    const stopProgress = matchGpsToRoute(geometry, {
      latitude: stop.latitude,
      longitude: stop.longitude,
      accuracyM: 1
    });

    const distanceM = stopProgress.distanceAlongM - progress.distanceAlongM;

    // If an unfinished stop is materially behind the bus on the expected path,
    // route geometry cannot safely describe how to reach it from here.
    if (distanceM < -60) {
      return boardEtaSchema.parse({
        status: "unavailable",
        source: null,
        generatedAt: null,
        stops: []
      });
    }

    const safeDistanceM = Math.max(0, distanceM);
    const durationSecondsFromNow =
      travelSecondsFromLivePace(safeDistanceM, pace) +
      dwellBeforeStopSeconds(etaStops, index, nowMs);

    fallbackStops.push({
      stopId: stop.id,
      label: stop.label,
      etaAt: new Date(
        nowMs + durationSecondsFromNow * 1000
      ).toISOString(),
      durationSecondsFromNow,
      distanceMFromNow: safeDistanceM,
      actualArrival: false
    });
  }

  return boardEtaSchema.parse({
    status: availability.freshness,
    source: "live-gps",
    generatedAt: new Date(nowMs).toISOString(),
    stops: fallbackStops
  });
}
