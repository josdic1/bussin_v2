type Coordinate = {
  latitude: number;
  longitude: number;
};

type MapboxTrafficResponse = {
  code?: string;
  message?: string;
  routes?: Array<{
    duration?: number;
    distance?: number;
  }>;
};

export type TrafficTravelTime = {
  durationSeconds: number;
  distanceM: number;
  source: "mapbox-traffic";
};

const MAPBOX_TRAFFIC_BASE =
  "https://api.mapbox.com/directions/v5/mapbox/driving-traffic";

function mapboxToken(): string {
  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("MAPBOX_ACCESS_TOKEN is not configured.");
  }
  return token;
}

export async function readTrafficTravelTime(
  current: Coordinate,
  remainingStops: Coordinate[]
): Promise<TrafficTravelTime | null> {
  if (remainingStops.length === 0) {
    return {
      durationSeconds: 0,
      distanceM: 0,
      source: "mapbox-traffic"
    };
  }

  const coordinates = [current, ...remainingStops];

  if (coordinates.length > 25) {
    throw new Error("Traffic routing supports at most 25 coordinates per request.");
  }

  const path = coordinates
    .map(({ longitude, latitude }) => `${longitude},${latitude}`)
    .join(";");

  const url = new URL(`${MAPBOX_TRAFFIC_BASE}/${path}`);
  url.searchParams.set("access_token", mapboxToken());
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000)
  });

  const body =
    await response.json().catch(() => null) as MapboxTrafficResponse | null;

  const route = body?.routes?.[0];

  if (
    !response.ok ||
    body?.code !== "Ok" ||
    typeof route?.duration !== "number" ||
    !Number.isFinite(route.duration) ||
    route.duration < 0 ||
    typeof route.distance !== "number" ||
    !Number.isFinite(route.distance) ||
    route.distance < 0
  ) {
    return null;
  }

  return {
    durationSeconds: route.duration,
    distanceM: route.distance,
    source: "mapbox-traffic"
  };
}
