import type { PoolClient } from "pg";
import { applyTripAction } from "../trips/actions.js";

export const JOURNEY_CONFIG = {
  maxAccuracyM: 35,
  arrivalRadiusM: 45,
  arrivalEvidenceCount: 3,
  arrivalMinSpanMs: 12_000,
  arrivalMaxSpeedMps: 4,
  departureRadiusM: 75,
  departureEvidenceCount: 3,
  departureMinSpanMs: 12_000,
  departureMinOutwardProgressM: 15,
  departureBacktrackToleranceM: 8,
  sampleLookback: 8
} as const;

type JourneySample = {
  observedAt: Date;
  latitude: number;
  longitude: number;
  accuracyM: number;
  speedMps: number | null;
};

type StopPoint = {
  latitude: number;
  longitude: number;
};

function radians(value: number): number {
  return value * Math.PI / 180;
}

export function distanceMeters(a: StopPoint, b: StopPoint): number {
  const earthRadiusM = 6_371_000;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(haversine));
}

function latestConsecutiveEvidence(
  samples: JourneySample[],
  predicate: (sample: JourneySample) => boolean,
  count: number
): JourneySample[] {
  const ordered = [...samples].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const evidence: JourneySample[] = [];
  for (const sample of ordered) {
    if (!predicate(sample)) break;
    evidence.push(sample);
    if (evidence.length === count) break;
  }
  return evidence.reverse();
}

export function hasArrivalEvidence(samples: JourneySample[], stop: StopPoint): boolean {
  const evidence = latestConsecutiveEvidence(
    samples,
    (sample) => sample.accuracyM <= JOURNEY_CONFIG.maxAccuracyM &&
      distanceMeters(sample, stop) <= JOURNEY_CONFIG.arrivalRadiusM &&
      (sample.speedMps === null || sample.speedMps <= JOURNEY_CONFIG.arrivalMaxSpeedMps),
    JOURNEY_CONFIG.arrivalEvidenceCount
  );
  if (evidence.length < JOURNEY_CONFIG.arrivalEvidenceCount) return false;
  return evidence.at(-1)!.observedAt.getTime() - evidence[0].observedAt.getTime() >=
    JOURNEY_CONFIG.arrivalMinSpanMs;
}

export function hasDepartureEvidence(samples: JourneySample[], stop: StopPoint): boolean {
  const evidence = latestConsecutiveEvidence(
    samples,
    (sample) => sample.accuracyM <= JOURNEY_CONFIG.maxAccuracyM &&
      distanceMeters(sample, stop) >= JOURNEY_CONFIG.departureRadiusM,
    JOURNEY_CONFIG.departureEvidenceCount
  );
  if (evidence.length < JOURNEY_CONFIG.departureEvidenceCount) return false;

  const span = evidence.at(-1)!.observedAt.getTime() - evidence[0].observedAt.getTime();
  if (span < JOURNEY_CONFIG.departureMinSpanMs) return false;

  const distances = evidence.map((sample) => distanceMeters(sample, stop));
  if (distances.at(-1)! - distances[0] < JOURNEY_CONFIG.departureMinOutwardProgressM) return false;

  for (let index = 1; index < distances.length; index += 1) {
    if (distances[index] + JOURNEY_CONFIG.departureBacktrackToleranceM < distances[index - 1]) {
      return false;
    }
  }
  return true;
}

type JourneyStopRow = {
  id: string;
  position: number;
  latitude: number;
  longitude: number;
  arrivedAt: Date | null;
  departedAt: Date | null;
};

async function recentSamples(
  client: PoolClient,
  tripId: string,
  since: Date | null
): Promise<JourneySample[]> {
  const result = await client.query<JourneySample>(
    `SELECT observed_at AS "observedAt",
            latitude::double precision AS latitude,
            longitude::double precision AS longitude,
            accuracy_m::double precision AS "accuracyM",
            speed_mps::double precision AS "speedMps"
       FROM trip_location_samples
      WHERE trip_id = $1
        AND ($2::timestamptz IS NULL OR observed_at >= $2)
      ORDER BY observed_at DESC
      LIMIT $3`,
    [tripId, since, JOURNEY_CONFIG.sampleLookback]
  );
  return result.rows;
}

export async function applyJourneyFromGps(
  client: PoolClient,
  input: { tripId: string; actorId: string }
): Promise<"arrived" | "departed" | null> {
  const stops = await client.query<JourneyStopRow>(
    `SELECT s.id,
            s.position,
            s.latitude::double precision AS latitude,
            s.longitude::double precision AS longitude,
            arrived.occurred_at AS "arrivedAt",
            departed.occurred_at AS "departedAt"
       FROM trip_stops s
       LEFT JOIN LATERAL (
         SELECT e.occurred_at
           FROM trip_events e
          WHERE e.trip_id = s.trip_id
            AND e.trip_stop_id = s.id
            AND e.event_type = 'arrived_stop'
            AND NOT EXISTS (
              SELECT 1 FROM trip_events replacement
               WHERE replacement.replaces_event_id = e.id
            )
          ORDER BY e.occurred_at DESC, e.recorded_at DESC
          LIMIT 1
       ) arrived ON true
       LEFT JOIN LATERAL (
         SELECT e.occurred_at
           FROM trip_events e
          WHERE e.trip_id = s.trip_id
            AND e.trip_stop_id = s.id
            AND e.event_type = 'departed_stop'
            AND NOT EXISTS (
              SELECT 1 FROM trip_events replacement
               WHERE replacement.replaces_event_id = e.id
            )
          ORDER BY e.occurred_at DESC, e.recorded_at DESC
          LIMIT 1
       ) departed ON true
      WHERE s.trip_id = $1
      ORDER BY s.position`,
    [input.tripId]
  );

  const next = stops.rows.find((stop) => !stop.departedAt);
  if (!next) return null;
  const finalStop = stops.rows.at(-1);
  const stopPoint = { latitude: next.latitude, longitude: next.longitude };

  if (!next.arrivedAt) {
    const samples = await recentSamples(client, input.tripId, null);
    if (!hasArrivalEvidence(samples, stopPoint)) return null;
    const outcome = await applyTripAction(client, {
      tripId: input.tripId,
      actorId: input.actorId,
      assignedStaffMemberId: input.actorId,
      action: { type: "arrive", stopId: next.id },
      eventNote: "journey:gps"
    });
    return outcome.ok ? "arrived" : null;
  }

  if (next.id === finalStop?.id) return null;

  const samples = await recentSamples(client, input.tripId, next.arrivedAt);
  if (!hasDepartureEvidence(samples, stopPoint)) return null;
  const outcome = await applyTripAction(client, {
    tripId: input.tripId,
    actorId: input.actorId,
    assignedStaffMemberId: input.actorId,
    action: { type: "depart", stopId: next.id },
    eventNote: "journey:gps"
  });
  return outcome.ok ? "departed" : null;
}
