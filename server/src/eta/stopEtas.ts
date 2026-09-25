import { dwellBeforeStopSeconds } from "./dwell.js";

export type EtaStop = {
  id: string;
  label: string;
  arrivedAt: string | null;
  departedAt: string | null;
};

export type EtaTrafficLeg = {
  durationSeconds: number;
  distanceM: number;
};

export type StopEta = {
  stopId: string;
  label: string;
  etaAt: string;
  durationSecondsFromNow: number;
  distanceMFromNow: number;
  actualArrival: boolean;
};

export function buildTrafficStopEtas(
  stops: EtaStop[],
  legs: EtaTrafficLeg[],
  nowMs = Date.now()
): StopEta[] {
  if (stops.length !== legs.length) {
    throw new Error("Traffic legs must match remaining stops.");
  }

  const currentStopAlreadyArrived =
    Boolean(stops[0]?.arrivedAt) &&
    !stops[0]?.departedAt;

  let cumulativeDriveSeconds = 0;
  let cumulativeDistanceM = 0;

  return stops.map((stop, index) => {
    // If the driver has already marked the current stop ARRIVED, the bus is
    // already there. Do not count Mapbox's small GPS -> current-stop leg.
    if (!(index === 0 && currentStopAlreadyArrived)) {
      cumulativeDriveSeconds += legs[index].durationSeconds;
      cumulativeDistanceM += legs[index].distanceM;
    }

    if (stop.arrivedAt && !stop.departedAt) {
      return {
        stopId: stop.id,
        label: stop.label,
        etaAt: stop.arrivedAt,
        durationSecondsFromNow: 0,
        distanceMFromNow: 0,
        actualArrival: true
      };
    }

    const dwellSeconds = dwellBeforeStopSeconds(
      stops,
      index,
      nowMs
    );

    const durationSecondsFromNow =
      cumulativeDriveSeconds + dwellSeconds;

    return {
      stopId: stop.id,
      label: stop.label,
      etaAt: new Date(
        nowMs + durationSecondsFromNow * 1000
      ).toISOString(),
      durationSecondsFromNow,
      distanceMFromNow: cumulativeDistanceM,
      actualArrival: false
    };
  });
}
