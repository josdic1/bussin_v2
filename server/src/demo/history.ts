import type { PoolClient } from "pg";
import { CAMP_TIME_ZONE } from "@bussin/shared";
import { createTrip } from "../trips/create.js";
import { saveCrew } from "../dispatch/crew.js";
import { CURRENT_ROUTE } from "../schedules/build.js";

/*
 * Fill in the past so History, Reports and Replay look like a camp that has been running:
 * every scheduled run on every past camp day in the range, driven start to finish, with
 * GPS trails along the road, kids checked on and off, and the ordinary bumps of a real
 * season (a few late starts, a no-show here and there, the odd cancelled run, a few
 * arrivals tapped by hand). Days that already have their trip are left alone.
 */

export type HistorySpan = "day" | "week" | "month" | "season";
const SPAN_DAYS: Record<HistorySpan, number> = { day: 1, week: 7, month: 30, season: 120 };
const MIN = 60_000;

type Point = [number, number]; // lat, lng

/** A steady pseudo-random number from a string, so the same trip always gets the same bumps. */
function chance(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** The road between each pair of stops: the stored route shape when there is one, else a straight line. */
function legs(stops: Point[], shape: Point[] | null): Point[][] {
  if (!shape || shape.length < 2) return stops.slice(1).map((stop, i) => [stops[i]!, stop]);
  const nearest = (stop: Point, from: number) => {
    let best = from, bestD = Infinity;
    for (let i = from; i < shape.length; i++) {
      const d = (shape[i]![0] - stop[0]) ** 2 + (shape[i]![1] - stop[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const marks: number[] = [];
  let from = 0;
  for (const stop of stops) { from = nearest(stop, from); marks.push(from); }
  return stops.slice(1).map((stop, i) => {
    const piece = shape.slice(marks[i]!, marks[i + 1]! + 1);
    return [stops[i]!, ...piece, stop];
  });
}

/** Where along a leg the bus is, 0 to 1 of the way. */
function along(leg: Point[], k: number): Point {
  const lengths = leg.slice(1).map((p, i) => Math.hypot(p[0] - leg[i]![0], p[1] - leg[i]![1]));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  let target = Math.max(0, Math.min(1, k)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i]!) {
      const f = lengths[i]! ? target / lengths[i]! : 0;
      return [leg[i]![0] + (leg[i + 1]![0] - leg[i]![0]) * f, leg[i]![1] + (leg[i + 1]![1] - leg[i]![1]) * f];
    }
    target -= lengths[i]!;
  }
  return leg.at(-1)!;
}

export async function fillHistory(client: PoolClient, span: HistorySpan) {
  // Backdated GPS would be refused by the live-sample guard; switched off for this transaction only.
  await client.query("ALTER TABLE trip_location_samples DISABLE TRIGGER accept_trip_location_sample");

  const runs = await client.query<{
    scheduleId: string; routeId: string; busId: string; day: string; departure: Date;
    leadId: string | null; counselorIds: string[]; driverId: string | null;
  }>(
    `SELECT s.id AS "scheduleId", s.route_id AS "routeId", s.bus_id AS "busId", to_char(d, 'YYYY-MM-DD') AS day,
            ((d::date + s.depart_time) AT TIME ZONE $1) AS departure,
            s.lead_id AS "leadId", s.counselor_ids AS "counselorIds", s.driver_id AS "driverId"
       FROM trip_schedules s
      CROSS JOIN LATERAL generate_series(
        GREATEST(s.starts_on, (now() AT TIME ZONE $1)::date - $2::int),
        (now() AT TIME ZONE $1)::date - 1, interval '1 day') d
      WHERE s.stopped_at IS NULL
        AND extract(isodow FROM d)::smallint = ANY (s.weekdays)
        AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.schedule_id = s.id AND t.service_date = d::date)
      ORDER BY departure, s.id`,
    [CAMP_TIME_ZONE, SPAN_DAYS[span]]);

  // "A day" means the last camp day, not literally yesterday (which might be a Sunday).
  const lastDay = runs.rows.at(-1)?.day;
  const rows = span === "day" ? runs.rows.filter((row) => row.day === lastDay) : runs.rows;

  const shapes = new Map<string, Point[] | null>();
  let made = 0, cancelled = 0;
  for (const run of rows) {
    const route = await client.query<{ id: string; active: boolean }>(CURRENT_ROUTE, [run.routeId]);
    if (!route.rows[0]?.active || !run.leadId) continue;
    await client.query("SAVEPOINT demo_history");
    const created = await createTrip(client, {
      routeId: route.rows[0].id, busId: run.busId, departure: run.departure, schedule: { id: run.scheduleId, day: run.day }
    });
    if (!created.ok) { await client.query("ROLLBACK TO SAVEPOINT demo_history"); continue; }
    const tripId = created.trip.id;
    try {
      await saveCrew(client, tripId, { leadId: run.leadId, counselorIds: run.counselorIds, driverId: run.driverId });
    } catch { await client.query("ROLLBACK TO SAVEPOINT demo_history"); continue; }
    const lead = run.leadId;
    const seed = `${run.scheduleId}:${run.day}`;
    const depart = run.departure.getTime();

    // About 1 run in 40 was called off that morning.
    if (chance(`${seed}:cancel`) < 0.025) {
      const at = new Date(depart - 50 * MIN);
      await client.query(`UPDATE trips SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`, [tripId, at]);
      await client.query(`INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at, note) VALUES ($1, 'cancelled', $2, $3, $4)`,
        [tripId, lead, at, chance(`${seed}:why`) < 0.5 ? "Driver out sick" : "Bus in the shop"]);
      await client.query("RELEASE SAVEPOINT demo_history");
      cancelled++; made++;
      continue;
    }

    const kids = (await client.query<{ riderId: string }>(`SELECT rider_id AS "riderId" FROM trip_riders WHERE trip_id = $1`, [tripId])).rows;
    // Parents who said "not riding" did it the night before.
    const notRiding = kids.filter((kid) => chance(`${seed}:${kid.riderId}:off`) < 0.03);
    for (const kid of notRiding) {
      await client.query(`INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by, occurred_at) VALUES ($1, $2, 'not_riding', $3, $4)`,
        [tripId, kid.riderId, lead, new Date(depart - 14 * 60 * MIN)]);
    }

    // Most runs leave within a few minutes; now and then one is properly late.
    const roll = chance(`${seed}:late`);
    const delay = roll < 0.07 ? 6 + Math.round(roll * 100) : Math.round(roll * 4) - 1;
    const started = depart + delay * MIN;
    await client.query(`UPDATE trips SET status = 'active', started_at = $2 WHERE id = $1`, [tripId, new Date(started)]);
    await client.query(`INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at) VALUES ($1, 'started', $2, $3)`, [tripId, lead, new Date(started)]);

    const stops = (await client.query<{ id: string; latitude: number; longitude: number }>(
      `SELECT id, latitude::float8 AS latitude, longitude::float8 AS longitude FROM trip_stops WHERE trip_id = $1 ORDER BY position`, [tripId])).rows;
    if (!shapes.has(route.rows[0].id)) {
      const shape = await client.query<{ geometry: { coordinates?: [number, number][] } }>(`SELECT geometry FROM route_geometries WHERE route_id = $1`, [route.rows[0].id]);
      const coords = shape.rows[0]?.geometry?.coordinates;
      shapes.set(route.rows[0].id, coords?.length ? coords.map(([lng, lat]) => [lat, lng] as Point) : null);
    }
    const roads = legs(stops.map((stop) => [stop.latitude, stop.longitude] as Point), shapes.get(route.rows[0].id) ?? null);

    // Stop times: 3 minutes to the first stop's doors, 8 to 14 minutes a leg, a minute at each stop.
    const times: { arrive: number; depart: number }[] = [];
    let clock = started + 3 * MIN;
    for (let i = 0; i < stops.length; i++) {
      if (i > 0) clock += (8 + Math.round(chance(`${seed}:leg${i}`) * 6)) * MIN;
      const last = i === stops.length - 1;
      times.push({ arrive: clock, depart: last ? clock : clock + MIN + Math.round(chance(`${seed}:dwell${i}`) * 60_000) });
      clock = times[i]!.depart;
    }
    const finished = times.at(-1)!.arrive;

    // Stop arrivals: almost always from GPS; 1 in 12 tapped by the counselor.
    const stopEvents: unknown[][] = [];
    stops.forEach((stop, i) => {
      const tapped = chance(`${seed}:tap${i}`) < 0.08;
      stopEvents.push([tripId, "arrived_stop", stop.id, lead, new Date(times[i]!.arrive), tapped ? null : "journey:gps"]);
      if (i < stops.length - 1) stopEvents.push([tripId, "departed_stop", stop.id, lead, new Date(times[i]!.depart), "journey:gps"]);
    });
    await client.query(
      `INSERT INTO trip_events (trip_id, event_type, trip_stop_id, recorded_by, occurred_at, note)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[], $5::timestamptz[], $6::text[])`,
      [0, 1, 2, 3, 4, 5].map((c) => stopEvents.map((row) => row[c])));

    // The GPS trail, a fix every 30 seconds along the road.
    const at: Date[] = [], lats: number[] = [], lngs: number[] = [], speeds: number[] = [];
    for (let t = started + 20_000; t <= finished; t += 30_000) {
      let point: Point = [stops[0]!.latitude, stops[0]!.longitude];
      let moving = false;
      for (let i = 0; i < stops.length; i++) {
        if (t <= times[i]!.depart) { point = [stops[i]!.latitude, stops[i]!.longitude]; break; }
        const next = times[i + 1];
        if (next && t < next.arrive) { point = along(roads[i]!, (t - times[i]!.depart) / (next.arrive - times[i]!.depart)); moving = true; break; }
      }
      at.push(new Date(t)); lats.push(Number(point[0].toFixed(6))); lngs.push(Number(point[1].toFixed(6)));
      speeds.push(moving ? 8 + chance(`${seed}:${t}`) * 6 : 0);
    }
    if (at.length) {
      await client.query(
        `INSERT INTO trip_location_samples (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m, speed_mps, heading_degrees)
         SELECT $1, $2, gen_random_uuid(), o, la, lo, 6, sp, NULL FROM unnest($3::timestamptz[], $4::float8[], $5::float8[], $6::float8[]) AS x(o, la, lo, sp)`,
        [tripId, lead, at, lats, lngs, speeds]);
    }

    // Ride Check: on at the first stops, off at the last; a rare no-show.
    const riding = kids.filter((kid) => !notRiding.includes(kid));
    const checks: unknown[][] = [];
    riding.forEach((kid, i) => {
      if (chance(`noshow:${kid.riderId}:${seed}`) < 0.025) { checks.push([kid.riderId, "no_show", new Date(times[0]!.arrive + 30_000)]); return; }
      const board = times[Math.min(i % Math.max(1, stops.length - 1), stops.length - 2)] ?? times[0]!;
      checks.push([kid.riderId, "boarded", new Date(board.arrive + 20_000 + (i % 30) * 2_000)]);
      checks.push([kid.riderId, "dropped_off", new Date(finished + 60_000 + (i % 30) * 3_000)]);
    });
    if (checks.length) {
      await client.query(
        `INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by, occurred_at)
         SELECT $1, r, e, $2, o FROM unnest($3::uuid[], $4::text[], $5::timestamptz[]) AS x(r, e, o)`,
        [tripId, lead, checks.map((c) => c[0]), checks.map((c) => c[1]), checks.map((c) => c[2])]);
    }
    if (chance(`${seed}:sweep`) < 0.96) {
      await client.query(`INSERT INTO trip_sweeps (trip_id, recorded_by, occurred_at) VALUES ($1, $2, $3)`, [tripId, lead, new Date(finished + 4 * MIN)]);
    }

    const ended = new Date(finished + 5 * MIN);
    await client.query(`INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at) VALUES ($1, 'completed', $2, $3)`, [tripId, lead, ended]);
    await client.query(`UPDATE trips SET status = 'completed', ended_at = $2 WHERE id = $1`, [tripId, ended]);
    await client.query("RELEASE SAVEPOINT demo_history");
    made++;
  }

  await client.query("ALTER TABLE trip_location_samples ENABLE TRIGGER accept_trip_location_sample");
  return { trips: made, cancelled, days: new Set(rows.map((row) => row.day)).size };
}
