import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { applyJourneyFromGps } from "../staff/journey.js";
import { applyTripAction } from "../trips/actions.js";
import { demoActive } from "./mode.js";
import { resetDemo } from "./reset.js";

/*
 * The robot driver, demo only. When it's on, every bus whose run is due leaves on time,
 * drives its route along the road, stops at each stop, and the kids get on and off.
 *
 * It doesn't fake the results. It sends GPS fixes the same way a bus phone does, and the
 * app's own stop detection decides when the bus has arrived and left. So Today, the
 * parent's phone, the counselor's screen, push alerts and History all react exactly as
 * they would to a real bus.
 *
 * Someone who wants to really drive a bus taps Start on the counselor screen before the
 * robot does; the robot leaves any trip it didn't start alone.
 */

type Point = [number, number]; // lat, lng
type Plan = {
  tripId: string; leadId: string; period: "AM" | "PM";
  stops: { id: string; at: Point }[];
  legs: Point[][];
  /** Real-time windows: dwell at stop i from arrive[i] to leave[i]. */
  arrive: number[]; leave: number[];
  seen: Set<string>; finished: boolean;
};

const TICK_MS = 4_000;            // a fix every 4 seconds: enough for stop detection
const DWELL_MS = 28_000;          // time parked at each stop, in real seconds, whatever the speed
const BUS_MPS = 11;               // about 25 mph

let speed = 10;                   // 0 = off. The demo starts driving by itself.
const plans = new Map<string, Plan>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** True while the demo robot is driving this trip. Always false on the real app. */
export function robotDrives(tripId: string) { return speed > 0 && !!plans.get(tripId) && !plans.get(tripId)!.finished; }

let nextRun: { period: "AM" | "PM"; at: number } | null = null;
export function simulatorState() {
  return { speed, buses: [...plans.values()].filter((plan) => !plan.finished).length, nextRun: nextRun ? { period: nextRun.period, at: new Date(nextRun.at).toISOString() } : null };
}

export function setSimulator(next: number) {
  speed = next;
  if (!speed) plans.clear();
}

export function startSimulatorLoop() {
  if (timer) return;
  timer = setInterval(() => {
    if (!speed || ticking || !demoActive()) return;
    ticking = true;
    void tick().catch((error) => console.error("Demo driver tick failed", error)).finally(() => { ticking = false; });
  }, TICK_MS);
  timer.unref();
}

const meters = (a: Point, b: Point) => {
  const r = (d: number) => d * Math.PI / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};
const length = (leg: Point[]) => leg.slice(1).reduce((sum, p, i) => sum + meters(leg[i]!, p), 0);
function along(leg: Point[], k: number): Point {
  let target = Math.max(0, Math.min(1, k)) * length(leg);
  for (let i = 1; i < leg.length; i++) {
    const piece = meters(leg[i - 1]!, leg[i]!);
    if (target <= piece) {
      const f = piece ? target / piece : 0;
      return [leg[i - 1]![0] + (leg[i]![0] - leg[i - 1]![0]) * f, leg[i - 1]![1] + (leg[i]![1] - leg[i - 1]![1]) * f];
    }
    target -= piece;
  }
  return leg.at(-1)!;
}

/** Split the stored road shape at each stop; straight lines when there's no shape. */
function roads(stops: Point[], shape: Point[] | null): Point[][] {
  if (!shape || shape.length < 2) return stops.slice(1).map((stop, i) => [stops[i]!, stop]);
  const marks: number[] = [];
  let from = 0;
  for (const stop of stops) {
    let best = from, bestD = Infinity;
    for (let i = from; i < shape.length; i++) {
      const d = (shape[i]![0] - stop[0]) ** 2 + (shape[i]![1] - stop[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    marks.push(best); from = best;
  }
  return stops.slice(1).map((stop, i) => [stops[i]!, ...shape.slice(marks[i]!, marks[i + 1]! + 1), stop]);
}

async function makePlan(tripId: string, leadId: string, period: "AM" | "PM", routeId: string, fromStop: number): Promise<Plan> {
  const stops = (await pool.query<{ id: string; latitude: number; longitude: number }>(
    `SELECT id, latitude::float8 AS latitude, longitude::float8 AS longitude FROM trip_stops WHERE trip_id = $1 ORDER BY position`, [tripId])).rows;
  const shape = await pool.query<{ geometry: { coordinates?: [number, number][] } }>(`SELECT geometry FROM route_geometries WHERE route_id = $1`, [routeId]);
  const coords = shape.rows[0]?.geometry?.coordinates;
  const points = stops.map((stop) => [stop.latitude, stop.longitude] as Point);
  const legs = roads(points, coords?.length ? coords.map(([lng, lat]) => [lat, lng] as Point) : null);
  const arrive: number[] = [], leave: number[] = [];
  let clock = Date.now();
  for (let i = 0; i < stops.length; i++) {
    if (i > fromStop) clock += Math.max(15_000, (length(legs[i - 1]!) / BUS_MPS / speed) * 1000);
    arrive.push(i < fromStop ? 0 : clock);
    leave.push(i < fromStop ? 0 : clock + DWELL_MS);
    if (i >= fromStop) clock += DWELL_MS;
  }
  return { tripId, leadId, period, stops: stops.map((stop, i) => ({ id: stop.id, at: points[i]! })), legs, arrive, leave, seen: new Set(), finished: false };
}

function position(plan: Plan, now: number): { at: Point; moving: boolean } {
  const last = plan.stops.length - 1;
  for (let i = 0; i <= last; i++) {
    if (!plan.arrive[i]) continue;
    if (now < plan.arrive[i]!) {
      const prev = i - 1;
      if (prev < 0 || !plan.leave[prev]) return { at: plan.stops[i]!.at, moving: false };
      const k = (now - plan.leave[prev]!) / (plan.arrive[i]! - plan.leave[prev]!);
      return { at: along(plan.legs[prev]!, k), moving: true };
    }
    if (now <= plan.leave[i]! || i === last) return { at: plan.stops[i]!.at, moving: false };
  }
  return { at: plan.stops[last]!.at, moving: false };
}

async function tick() {
  const now = Date.now();
  // 1. Runs that are due leave on time.
  const due = await pool.query<{ id: string; leadId: string; period: "AM" | "PM"; routeId: string }>(
    `SELECT t.id, a.member_id AS "leadId", r.service_period AS period, t.route_id AS "routeId"
       FROM trips t JOIN routes r ON r.id = t.route_id
       JOIN staff_assignments a ON a.trip_id = t.id AND a.ended_at IS NULL AND a.crew_role = 'lead'
      WHERE t.status = 'planned' AND t.departure_at <= now() AND t.departure_at > now() - interval '3 hours'`);
  for (const trip of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const started = await applyTripAction(client, { tripId: trip.id, action: { type: "start" }, actorId: trip.leadId });
      await client.query(started.ok ? "COMMIT" : "ROLLBACK");
      if (started.ok) {
        const plan = await makePlan(trip.id, trip.leadId, trip.period, trip.routeId, 0);
        plans.set(trip.id, plan);
        // Afternoon: everyone gets on at camp before the bus pulls out.
        if (plan.period === "PM") await boardEveryone(plan);
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Demo driver could not start a trip", error);
    } finally { client.release(); }
  }

  // 2. Drive every bus the robot started.
  for (const plan of plans.values()) {
    if (plan.finished) continue;
    const status = await pool.query<{ status: string }>(`SELECT status FROM trips WHERE id = $1`, [plan.tripId]);
    if (status.rows[0]?.status !== "active") { plan.finished = true; continue; }
    const { at, moving } = position(plan, now);
    // The counselor's phone is "on": Today shows the staff phone reporting, as it would in a real bus.
    await pool.query(`INSERT INTO staff_presence (member_id, last_seen_at) VALUES ($1, now())
                      ON CONFLICT (member_id) DO UPDATE SET last_seen_at = now()`, [plan.leadId]);
    await pool.query(
      `INSERT INTO trip_location_samples (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m, speed_mps, heading_degrees)
       VALUES ($1, $2, $3, now(), $4, $5, 8, $6, NULL)`,
      [plan.tripId, plan.leadId, randomUUID(), Number(at[0].toFixed(6)), Number(at[1].toFixed(6)), moving ? BUS_MPS : 0]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await applyJourneyFromGps(client, { tripId: plan.tripId, actorId: plan.leadId });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Demo driver stop detection failed", error);
    } finally { client.release(); }
    await kidsAtStops(plan);
    // Parked at the last stop long enough: walk the bus and finish, like a counselor would.
    const last = plan.stops.length - 1;
    if (plan.seen.has(plan.stops[last]!.id) && now > plan.leave[last]!) await finish(plan);
  }
  for (const [id, plan] of plans) if (plan.finished) plans.delete(id);
  await keepRunsComing();
}

/**
 * Always something to watch: when nothing is running or about to leave, the next run
 * (morning, then afternoon, then morning again) leaves a minute later.
 */
async function keepRunsComing() {
  const busy = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM trips
      WHERE status = 'active' OR (status = 'planned' AND departure_at BETWEEN now() - interval '5 minutes' AND now() + interval '15 minutes')`);
  if (busy.rows[0]!.n > 0) { nextRun = null; return; }
  const camp = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM trip_schedules WHERE stopped_at IS NULL`);
  if (!camp.rows[0]!.n) return;
  const now = Date.now();
  if (!nextRun) {
    const last = await pool.query<{ period: "AM" | "PM" }>(
      `SELECT r.service_period AS period FROM trips t JOIN routes r ON r.id = t.route_id
        WHERE t.status = 'completed' ORDER BY t.ended_at DESC NULLS LAST LIMIT 1`);
    nextRun = { period: last.rows[0]?.period === "AM" ? "PM" : "AM", at: now + 45_000 };
    return;
  }
  if (now < nextRun.at) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await resetDemo(client, nextRun.period, 0.5);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Demo could not start the next run", error);
  } finally { client.release(); nextRun = null; }
}

/** When the app records an arrival, the kids for that stop get on (or off). */
async function kidsAtStops(plan: Plan) {
  const arrived = await pool.query<{ stopId: string }>(
    `SELECT DISTINCT trip_stop_id AS "stopId" FROM trip_events WHERE trip_id = $1 AND event_type = 'arrived_stop'`, [plan.tripId]);
  const last = plan.stops.length - 1;
  // Work through stops in order, so a stop whose arrival was missed still gets its kids on and off.
  // A stop counts as reached when the app saw the bus arrive, or once the bus has pulled away from it.
  const now = Date.now();
  let pulledAway = -1;
  for (let i = 0; i < plan.stops.length - 1; i++) if (plan.leave[i]! > 0 && plan.leave[i]! < now) pulledAway = i;
  const reached = Math.max(pulledAway, ...arrived.rows.map((row) => plan.stops.findIndex((stop) => stop.id === row.stopId)));
  for (let index = 0; index <= reached; index++) {
    const stopId = plan.stops[index]!.id;
    if (plan.seen.has(stopId)) continue;
    plan.seen.add(stopId);
    const kids = (await pool.query<{ riderId: string; stopId: string | null; checked: boolean }>(
      `SELECT tr.rider_id AS "riderId", tr.trip_stop_id AS "stopId",
              EXISTS (SELECT 1 FROM trip_rider_events e WHERE e.trip_id = tr.trip_id AND e.rider_id = tr.rider_id) AS checked
         FROM trip_riders tr WHERE tr.trip_id = $1`, [plan.tripId])).rows;
    const on = plan.period === "PM" ? (index === 0 ? kids.filter((kid) => !kid.checked) : [])
      : kids.filter((kid) => kid.stopId === stopId && !kid.checked);
    const off = plan.period === "PM" ? (index > 0 ? kids.filter((kid) => kid.stopId === stopId) : [])
      : index === last ? kids : [];
    for (const kid of on) {
      const noShow = parseInt(kid.riderId.slice(-2), 16) % 33 === 0;
      await check(plan, kid.riderId, noShow ? "no_show" : "boarded");
    }
    for (const kid of off) {
      const boarded = await pool.query(`SELECT 1 FROM trip_rider_events WHERE trip_id = $1 AND rider_id = $2 AND event_type = 'boarded'`, [plan.tripId, kid.riderId]);
      if (boarded.rowCount) await check(plan, kid.riderId, "dropped_off");
    }
  }
}

async function boardEveryone(plan: Plan) {
  const kids = await pool.query<{ riderId: string }>(
    `SELECT tr.rider_id AS "riderId" FROM trip_riders tr WHERE tr.trip_id = $1
        AND NOT EXISTS (SELECT 1 FROM trip_rider_events e WHERE e.trip_id = tr.trip_id AND e.rider_id = tr.rider_id)`, [plan.tripId]);
  for (const kid of kids.rows) await check(plan, kid.riderId, parseInt(kid.riderId.slice(-2), 16) % 33 === 0 ? "no_show" : "boarded");
}

async function check(plan: Plan, riderId: string, type: "boarded" | "dropped_off" | "no_show") {
  await pool.query(`INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by) VALUES ($1, $2, $3, $4)`,
    [plan.tripId, riderId, type, plan.leadId]).catch(() => undefined);
}

async function finish(plan: Plan) {
  plan.finished = true;
  await pool.query(`INSERT INTO trip_sweeps (trip_id, recorded_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [plan.tripId, plan.leadId]).catch(() => undefined);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const done = await applyTripAction(client, { tripId: plan.tripId, action: { type: "complete" }, actorId: plan.leadId });
    await client.query(done.ok ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Demo driver could not finish a trip", error);
  } finally { client.release(); }
}
