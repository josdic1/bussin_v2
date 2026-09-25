import { pool } from "../db/pool.js";

type PaceRow = {
  speedMps: number | null;
};

export type LivePace = {
  speedMps: number;
  sampleCount: number;
  source: "live-gps";
};

export async function readLivePace(
  tripId: string
): Promise<LivePace | null> {
  const result = await pool.query<PaceRow>(
    `SELECT speed_mps::double precision AS "speedMps"
       FROM trip_location_samples
      WHERE trip_id = $1
        AND observed_at >= now() - interval '5 minutes'
        AND speed_mps IS NOT NULL
        AND speed_mps >= 0.5
        AND speed_mps <= 35
      ORDER BY observed_at DESC
      LIMIT 12`,
    [tripId]
  );

  const speeds = result.rows
    .map((row) => row.speedMps)
    .filter((speed): speed is number =>
      speed !== null && Number.isFinite(speed)
    )
    .sort((a, b) => a - b);

  if (speeds.length < 2) return null;

  const middle = Math.floor(speeds.length / 2);
  const median = speeds.length % 2 === 0
    ? (speeds[middle - 1] + speeds[middle]) / 2
    : speeds[middle];

  return {
    speedMps: median,
    sampleCount: speeds.length,
    source: "live-gps"
  };
}

export function travelSecondsFromLivePace(
  distanceM: number,
  pace: LivePace
): number {
  if (distanceM <= 0) return 0;
  return distanceM / pace.speedMps;
}
