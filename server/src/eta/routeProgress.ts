const EARTH_RADIUS_M = 6_371_000;

export type RouteCoordinate = readonly [number, number];

export type RouteProgressMatch = {
  segmentIndex: number;
  progressFraction: number;
  distanceAlongM: number;
  remainingM: number;
  distanceFromRouteM: number;
  offRouteThresholdM: number;
  offRoute: boolean;
  snappedLatitude: number;
  snappedLongitude: number;
};

function radians(value: number): number {
  return value * Math.PI / 180;
}

function haversineM(a: RouteCoordinate, b: RouteCoordinate): number {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(b[0] - a[0]);

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function relativeMeters(
  origin: RouteCoordinate,
  point: RouteCoordinate
): { x: number; y: number } {
  const latitude = radians((origin[1] + point[1]) / 2);

  return {
    x: radians(point[0] - origin[0]) * Math.cos(latitude) * EARTH_RADIUS_M,
    y: radians(point[1] - origin[1]) * EARTH_RADIUS_M
  };
}

export function matchGpsToRoute(
  geometry: RouteCoordinate[],
  gps: { latitude: number; longitude: number; accuracyM: number }
): RouteProgressMatch {
  if (geometry.length < 2) {
    throw new Error("Route geometry needs at least two points.");
  }

  const gpsCoordinate: RouteCoordinate = [gps.longitude, gps.latitude];

  let cumulativeM = 0;
  let bestDistanceM = Number.POSITIVE_INFINITY;
  let bestAlongM = 0;
  let bestSegmentIndex = 0;
  let bestLatitude = geometry[0][1];
  let bestLongitude = geometry[0][0];

  for (let index = 0; index < geometry.length - 1; index += 1) {
    const start = geometry[index];
    const end = geometry[index + 1];

    const a = relativeMeters(gpsCoordinate, start);
    const b = relativeMeters(gpsCoordinate, end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    const fraction = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));

    const closestX = a.x + dx * fraction;
    const closestY = a.y + dy * fraction;
    const distanceM = Math.hypot(closestX, closestY);
    const segmentLengthM = haversineM(start, end);

    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      bestAlongM = cumulativeM + segmentLengthM * fraction;
      bestSegmentIndex = index;
      bestLongitude = start[0] + (end[0] - start[0]) * fraction;
      bestLatitude = start[1] + (end[1] - start[1]) * fraction;
    }

    cumulativeM += segmentLengthM;
  }

  if (!Number.isFinite(cumulativeM) || cumulativeM <= 0) {
    throw new Error("Route geometry has no measurable length.");
  }

  const offRouteThresholdM = Math.max(
    60,
    Math.min(120, 40 + gps.accuracyM)
  );

  return {
    segmentIndex: bestSegmentIndex,
    progressFraction: Math.max(0, Math.min(1, bestAlongM / cumulativeM)),
    distanceAlongM: bestAlongM,
    remainingM: Math.max(0, cumulativeM - bestAlongM),
    distanceFromRouteM: bestDistanceM,
    offRouteThresholdM,
    offRoute: bestDistanceM > offRouteThresholdM,
    snappedLatitude: bestLatitude,
    snappedLongitude: bestLongitude
  };
}

export type StabilizedRouteProgress = RouteProgressMatch & {
  heldForBackwardNoise: boolean;
};

export function stabilizeRouteProgress(
  previousDistanceAlongM: number | null,
  current: RouteProgressMatch,
  allowBackward = false
): StabilizedRouteProgress {
  const totalDistanceM = current.distanceAlongM + current.remainingM;

  if (
    current.offRoute ||
    allowBackward ||
    previousDistanceAlongM === null ||
    current.distanceAlongM >= previousDistanceAlongM
  ) {
    return {
      ...current,
      heldForBackwardNoise: false
    };
  }

  const heldDistanceAlongM = Math.min(
    previousDistanceAlongM,
    totalDistanceM
  );

  return {
    ...current,
    distanceAlongM: heldDistanceAlongM,
    remainingM: Math.max(0, totalDistanceM - heldDistanceAlongM),
    progressFraction: heldDistanceAlongM / totalDistanceM,
    heldForBackwardNoise: true
  };
}
