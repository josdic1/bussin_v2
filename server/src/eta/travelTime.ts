import { readLivePace, travelSecondsFromLivePace } from "./livePace.js";
import { readTrafficTravelTime } from "./traffic.js";

type Coordinate = {
  latitude: number;
  longitude: number;
};

export type TravelTimeResult =
  | {
      durationSeconds: number;
      distanceM: number;
      source: "mapbox-traffic";
    }
  | {
      durationSeconds: number;
      distanceM: number;
      source: "live-gps";
    };

export async function resolveTravelTime(
  tripId: string,
  current: Coordinate,
  remainingStops: Coordinate[],
  fallbackDistanceM: number | null
): Promise<TravelTimeResult | null> {
  try {
    const traffic = await readTrafficTravelTime(current, remainingStops);
    if (traffic) return traffic;
  } catch {
    // Traffic failure must not fabricate an ETA.
  }

  if (
    fallbackDistanceM === null ||
    !Number.isFinite(fallbackDistanceM) ||
    fallbackDistanceM <= 0
  ) {
    return null;
  }

  const pace = await readLivePace(tripId);
  if (!pace) return null;

  return {
    durationSeconds: travelSecondsFromLivePace(fallbackDistanceM, pace),
    distanceM: fallbackDistanceM,
    source: "live-gps"
  };
}
