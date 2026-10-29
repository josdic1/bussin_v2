import { CAMP_TIME_ZONE } from "@bussin/shared";

// What a parent's phone should say about one running trip, worked out from plain facts.
// No database here, so the rules are easy to read and to test.
//
//   left     The bus left its first stop (camp, in the afternoon). Not sent when the
//            family's stop IS the first stop: they're standing there watching it go.
//   near     About 10 minutes from the family's stop, by the live ETA.
//   arrived  The bus is at the family's stop. Not sent for the first stop either.
//
// Old news is never sent: a "left" or "arrived" more than 20 minutes ago (a server that
// was down, say) is skipped, and once "arrived" is sent, "near" is never sent after it.

export type AlertKind = "left" | "near" | "arrived";
export type Alert = { kind: AlertKind; title: string; body: string };

export type TripFacts = {
  busLabel: string;
  servicePeriod: "AM" | "PM";
  stopLabel: string;
  firstStopLabel: string;
  stopIsFirst: boolean;
  leftFirstStopAt: Date | null;
  arrivedAt: Date | null;
  etaAt: Date | null;
  kids: string[]; // first names of this family's kids riding this trip
};

export const NEAR_MINUTES = 10;
const RECENT_MS = 20 * 60_000;

function clock(at: Date) {
  return at.toLocaleTimeString("en-US", { timeZone: CAMP_TIME_ZONE, hour: "numeric", minute: "2-digit" });
}

export function kidList(kids: string[]) {
  return kids.length <= 1 ? kids[0] ?? "" : `${kids.slice(0, -1).join(", ")} and ${kids.at(-1)}`;
}

/** Every alert that is due right now. The caller sends each one at most once per trip. */
export function dueAlerts(trip: TripFacts, now: Date): Alert[] {
  if (!trip.kids.length) return [];
  const who = kidList(trip.kids);
  const recent = (at: Date | null) => !!at && now.getTime() - at.getTime() < RECENT_MS;
  const alerts: Alert[] = [];

  if (!trip.stopIsFirst && recent(trip.leftFirstStopAt) && !trip.arrivedAt) {
    alerts.push({
      kind: "left",
      title: `${trip.busLabel} left ${trip.firstStopLabel}`,
      body: trip.etaAt
        ? `${who} · about ${clock(trip.etaAt)} at ${trip.stopLabel}`
        : `${who} · on the way to ${trip.stopLabel}`
    });
  }

  if (trip.arrivedAt) {
    if (!trip.stopIsFirst && recent(trip.arrivedAt)) {
      alerts.push({
        kind: "arrived",
        title: `${trip.busLabel} is at ${trip.stopLabel}`,
        body: trip.servicePeriod === "PM"
          ? `${who} ${trip.kids.length > 1 ? "are" : "is"} getting off now.`
          : `Time to get on. ${who}'s bus is at the stop.`
      });
    }
    return alerts;
  }

  if (trip.etaAt) {
    const minutes = Math.round((trip.etaAt.getTime() - now.getTime()) / 60_000);
    if (minutes <= NEAR_MINUTES && minutes >= -2) {
      alerts.push({
        kind: "near",
        title: minutes <= 1 ? `${trip.busLabel} is almost at ${trip.stopLabel}` : `${trip.busLabel} is ${minutes} min from ${trip.stopLabel}`,
        body: trip.servicePeriod === "PM"
          ? `${who} · about ${clock(trip.etaAt)}. Time to head over.`
          : `${who} · about ${clock(trip.etaAt)}. Time to head to the stop.`
      });
    }
  }
  return alerts;
}
