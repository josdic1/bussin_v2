import { pool } from "../db/pool.js";
import { buildDispatchEta } from "../eta/dispatchEta.js";
import { deriveRiderState, type RiderEventRow } from "../check/state.js";
import { dueAlerts, type TripFacts } from "./alerts.js";
import { pushPublicKey, pushToMember } from "./send.js";

// Every 30 seconds: for each running trip, each parent with alerts turned on gets
// "left", "near" and "arrived" once each, about their own kids who are riding.

const EVERY_MS = 30_000;

type Row = {
  memberId: string; tripId: string; riderId: string; givenName: string;
  busLabel: string; servicePeriod: "AM" | "PM"; stopId: string; stopLabel: string; stopIsFirst: boolean;
  firstStopLabel: string; leftFirstStopAt: Date | null; arrivedAt: Date | null;
};

/** One pass. Returns how many notifications went out. */
export async function sendDueAlerts(now = new Date()): Promise<number> {
  if (!pushPublicKey()) return 0;
  const live = (event: string, stop: string) => `(SELECT max(e.occurred_at) FROM trip_events e
      WHERE e.trip_id = t.id AND e.trip_stop_id = ${stop} AND e.event_type = '${event}'
        AND NOT EXISTS (SELECT 1 FROM trip_events c WHERE c.replaces_event_id = e.id))`;
  const rows = (await pool.query<Row>(
    `SELECT a.member_id AS "memberId", t.id AS "tripId", r.id AS "riderId", r.given_name AS "givenName",
            b.label AS "busLabel", route.service_period AS "servicePeriod",
            ts.id AS "stopId", ts.label AS "stopLabel", ts.position = first.position AS "stopIsFirst",
            first.label AS "firstStopLabel",
            ${live("departed_stop", "first.id")} AS "leftFirstStopAt",
            ${live("arrived_stop", "ts.id")} AS "arrivedAt"
       FROM family_trip_access a
       JOIN trips t ON t.id = a.trip_id AND t.status = 'active'
       JOIN routes route ON route.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       JOIN riders r ON r.id = a.rider_id
       JOIN trip_stops ts ON ts.trip_id = t.id AND ts.id = a.trip_stop_id
       JOIN LATERAL (SELECT s.id, s.label, s.position FROM trip_stops s WHERE s.trip_id = t.id ORDER BY s.position LIMIT 1) first ON true
      WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.member_id = a.member_id)
      ORDER BY a.member_id, t.id, r.given_name`)).rows;
  if (!rows.length) return 0;

  // Kids marked not riding don't get alerts.
  const tripIds = [...new Set(rows.map((row) => row.tripId))];
  const events = await pool.query<RiderEventRow & { tripId: string; riderId: string }>(
    `SELECT e.trip_id AS "tripId", e.rider_id AS "riderId", e.event_type AS "eventType",
            e.occurred_at AS "occurredAt", '' AS "recordedByName"
       FROM trip_rider_events e WHERE e.trip_id = ANY($1::uuid[])
      ORDER BY e.occurred_at, e.recorded_at, e.id`, [tripIds]);
  const byKid = new Map<string, RiderEventRow[]>();
  for (const event of events.rows) {
    const key = `${event.tripId}:${event.riderId}`;
    byKid.set(key, [...(byKid.get(key) ?? []), event]);
  }
  const skipped = (row: Row) => {
    const state = deriveRiderState(byKid.get(`${row.tripId}:${row.riderId}`) ?? []).state;
    return state === "not_riding" || state === "no_show";
  };

  // One ETA per trip.
  const etas = new Map<string, Awaited<ReturnType<typeof buildDispatchEta>>>();
  for (const tripId of tripIds) {
    try { etas.set(tripId, await buildDispatchEta(tripId)); } catch { /* no ETA this pass */ }
  }

  // One family, one trip, one stop: siblings share an alert.
  const families = new Map<string, { memberId: string; tripId: string; facts: TripFacts }>();
  for (const row of rows) {
    if (skipped(row)) continue;
    const key = `${row.memberId}:${row.tripId}:${row.stopId}`;
    const existing = families.get(key);
    if (existing) { existing.facts.kids.push(row.givenName); continue; }
    const eta = etas.get(row.tripId);
    const stopEta = eta && (eta.status === "live" || eta.status === "aging")
      ? eta.stops.find((stop) => stop.stopId === row.stopId && !stop.actualArrival) : undefined;
    families.set(key, {
      memberId: row.memberId, tripId: row.tripId,
      facts: {
        busLabel: row.busLabel, servicePeriod: row.servicePeriod, stopLabel: row.stopLabel,
        firstStopLabel: row.firstStopLabel, stopIsFirst: row.stopIsFirst,
        leftFirstStopAt: row.leftFirstStopAt, arrivedAt: row.arrivedAt,
        etaAt: stopEta?.etaAt ? new Date(stopEta.etaAt) : null,
        kids: [row.givenName]
      }
    });
  }

  let sent = 0;
  for (const family of families.values()) {
    const alerts = dueAlerts(family.facts, now);
    for (const alert of alerts) {
      // Claim it first: whoever inserts the row sends it, so nothing goes out twice.
      const claimed = await pool.query(
        `INSERT INTO push_sent (member_id, trip_id, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`,
        [family.memberId, family.tripId, alert.kind]);
      if (!claimed.rowCount) continue;
      if (alert.kind === "arrived") {
        await pool.query(`INSERT INTO push_sent (member_id, trip_id, kind) VALUES ($1, $2, 'near') ON CONFLICT DO NOTHING`,
          [family.memberId, family.tripId]);
      }
      sent += await pushToMember(family.memberId, { title: alert.title, body: alert.body, tag: `${family.tripId}:${alert.kind}` });
    }
  }
  return sent;
}

export function startPushAlerts(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sendDueAlerts().catch((error) => console.error("Phone alerts pass failed", error)).finally(() => { running = false; });
  }, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
