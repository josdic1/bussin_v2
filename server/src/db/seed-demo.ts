// Local demo data for trying the operations UI. Refuses production and refuses
// a database that already has buses. Pass --live to keep the running buses
// reporting GPS every few seconds (Ctrl-C to stop).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { hashPassword } from "../auth/sessions.js";
import { snapshotTripRiders } from "../families/access.js";
import { pool } from "./pool.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("Demo data is for local setup only");
}

const MIN = 60_000;
const live = process.argv.includes("--live");

type RouteSpec = { family: string; stops: [string, number, number][] };

const routeSpecs: RouteSpec[] = [
  { family: "Maplewood North", stops: [
    ["Maplewood Ave & 3rd", 40.7312, -74.2735], ["Oak St & Elm", 40.7345, -74.2688],
    ["Ridgewood Rd", 40.7381, -74.2652], ["Village Green", 40.7419, -74.2611],
    ["Baker Ave", 40.7446, -74.2570], ["Camp Gate", 40.7500, -74.2500]] },
  { family: "South Orange Village", stops: [
    ["Village Plaza", 40.7489, -74.2610], ["Scotland Rd", 40.7516, -74.2665],
    ["Irvington Ave", 40.7470, -74.2551], ["Academy St", 40.7455, -74.2600],
    ["Prospect St", 40.7532, -74.2572], ["Camp Gate", 40.7500, -74.2500]] },
  { family: "Millburn Loop", stops: [
    ["Millburn Ave", 40.7248, -74.3031], ["Essex St", 40.7275, -74.2962],
    ["Wyoming Ave", 40.7321, -74.2890], ["Main St", 40.7380, -74.2760],
    ["Camp Gate", 40.7500, -74.2500]] },
  { family: "Short Hills", stops: [
    ["Chatham Rd", 40.7430, -74.3280], ["Hobart Ave", 40.7461, -74.3150],
    ["Highland Ave", 40.7477, -74.2990], ["Camp Gate", 40.7500, -74.2500]] },
  { family: "Livingston Express", stops: [
    ["Livingston Mall", 40.7700, -74.3440], ["Northfield Rd", 40.7620, -74.3100],
    ["Camp Gate", 40.7500, -74.2500]] }
];

const staffNames = ["Dana Reyes", "Marcus Tull", "Priya Shah", "Luis Moreno", "Ana Ortiz", "Sam Okafor"];
const kids: Record<string, string[]> = {
  "Maplewood North": ["Ava Lopez", "Noah Lopez", "Zoe Grant", "Lena Fischer", "Max Fischer", "Theo Brooks"],
  "South Orange Village": ["Mira Nair", "Ben Chen", "Grace Chen", "Ife Okafor", "Finn Murphy", "Isla Novak"],
  "Millburn Loop": ["Eli Whitfield", "Wren Ellis", "Kai Tanaka", "Lila Frost"],
  "Short Hills": ["Ada Okoro", "Ivy Shah", "Luca Ferri"],
  "Livingston Express": ["Rosa Vega", "Andre Cole", "Tara Singh"]
};

const client = await pool.connect();

async function q<T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await client.query<T & import("pg").QueryResultRow>(sql, params)).rows;
}

async function createTrip(c: PoolClient, input: {
  routeId: string; busId: string; departureAt: Date; staffId: string | null;
}) {
  const [trip] = (await c.query<{ id: string }>(
    "INSERT INTO trips (route_id, bus_id, departure_at) VALUES ($1, $2, $3) RETURNING id",
    [input.routeId, input.busId, input.departureAt]
  )).rows;
  await c.query(
    `INSERT INTO trip_stops (trip_id, route_id, route_stop_id, position, label, latitude, longitude)
     SELECT $1, route_id, id, position, label, latitude, longitude
       FROM route_stops WHERE route_id = $2 ORDER BY position`,
    [trip.id, input.routeId]
  );
  await snapshotTripRiders(c, trip.id);
  if (input.staffId) {
    await c.query("INSERT INTO staff_assignments (trip_id, member_id, assigned_at) VALUES ($1, $2, $3)",
      [trip.id, input.staffId, new Date(input.departureAt.getTime() - 120 * MIN)]);
  }
  return trip.id;
}

type Stop = { id: string; position: number; latitude: number; longitude: number };

async function runTrip(c: PoolClient, input: {
  tripId: string; staffId: string; startedAt: Date; stopsDone: number;
  arrivedAtCurrent: boolean; complete: boolean; manualStops?: number[];
  gpsUntil: Date | null; now: Date; gapSeconds?: number;
}) {
  const stops = (await c.query<Stop>(
    `SELECT id, position, latitude::float8 AS latitude, longitude::float8 AS longitude
       FROM trip_stops WHERE trip_id = $1 ORDER BY position`, [input.tripId]
  )).rows;
  await c.query("UPDATE trips SET status = 'active', started_at = $2 WHERE id = $1",
    [input.tripId, input.startedAt]);
  await c.query(
    `INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at) VALUES ($1, 'started', $2, $3)`,
    [input.tripId, input.staffId, input.startedAt]
  );
  let cursor = input.startedAt.getTime();
  const stopTimes: { arrive: number; depart: number | null }[] = [];
  for (let index = 0; index < stops.length; index += 1) {
    const arrive = cursor + (index === 0 ? 3 : 6) * MIN;
    const last = index === stops.length - 1;
    const depart = last ? null : arrive + MIN;
    stopTimes.push({ arrive, depart });
    cursor = depart ?? arrive;
  }
  const note = (index: number) => input.manualStops?.includes(index) ? null : "journey:gps";
  for (let index = 0; index < stops.length; index += 1) {
    const done = index < input.stopsDone;
    const current = index === input.stopsDone && input.arrivedAtCurrent;
    if (!done && !current) break;
    await c.query(
      `INSERT INTO trip_events (trip_id, event_type, trip_stop_id, recorded_by, occurred_at, note)
       VALUES ($1, 'arrived_stop', $2, $3, $4, $5)`,
      [input.tripId, stops[index].id, input.staffId, new Date(stopTimes[index].arrive), note(index)]
    );
    if (done && stopTimes[index].depart) {
      await c.query(
        `INSERT INTO trip_events (trip_id, event_type, trip_stop_id, recorded_by, occurred_at, note)
         VALUES ($1, 'departed_stop', $2, $3, $4, 'journey:gps')`,
        [input.tripId, stops[index].id, input.staffId, new Date(stopTimes[index].depart!)]
      );
    }
  }
  // GPS samples every 20s along the path, until gpsUntil.
  const end = input.gpsUntil?.getTime() ?? input.startedAt.getTime();
  const gapFrom = input.startedAt.getTime() + 10 * MIN;
  const gapTo = gapFrom + (input.gapSeconds ?? 0) * 1000;
  for (let t = input.startedAt.getTime() + 20_000; t <= end; t += 20_000) {
    if (t > gapFrom && t < gapTo) continue;
    const point = positionAt(stops, stopTimes, t);
    await c.query(
      `INSERT INTO trip_location_samples
         (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m, speed_mps, heading_degrees)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [input.tripId, input.staffId, randomUUID(), new Date(t), point[0], point[1], 6 + (t / 1000) % 7, 7.5, 90]
    );
  }
  if (input.complete) {
    const endedAt = new Date(stopTimes.at(-1)!.arrive + MIN);
    await c.query(
      `INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at) VALUES ($1, 'completed', $2, $3)`,
      [input.tripId, input.staffId, endedAt]
    );
    await c.query("UPDATE trips SET status = 'completed', ended_at = $2 WHERE id = $1", [input.tripId, endedAt]);
  }
  return { stops, stopTimes };
}

function positionAt(stops: Stop[], times: { arrive: number; depart: number | null }[], t: number): [number, number] {
  for (let index = 0; index < stops.length; index += 1) {
    const next = stops[index + 1];
    const leave = times[index].depart ?? times[index].arrive;
    if (t <= leave || !next) return [stops[index].latitude, stops[index].longitude];
    if (t < times[index + 1].arrive) {
      const k = (t - leave) / (times[index + 1].arrive - leave);
      return [
        stops[index].latitude + (next.latitude - stops[index].latitude) * k,
        stops[index].longitude + (next.longitude - stops[index].longitude) * k
      ];
    }
  }
  const last = stops.at(-1)!;
  return [last.latitude, last.longitude];
}

async function check(tripId: string, riderName: string, type: string, at: Date, actor: string) {
  const [given, family] = riderName.split(" ");
  await q(
    `INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by, occurred_at)
     SELECT $1, r.id, $4, $5, $6 FROM riders r WHERE r.given_name = $2 AND r.family_name = $3`,
    [tripId, given, family, type, actor, at]
  );
}

try {
  const [{ count }] = await q<{ count: string }>("SELECT count(*)::text AS count FROM buses");
  if (count !== "0" && !live) throw new Error("This database already has buses. Seed an empty database.");

  if (count === "0") {
    await client.query("BEGIN");
    // Historical GPS is backdated on purpose; the live-sample freshness guard
    // is switched off for this transaction only and restored before commit.
    await client.query("ALTER TABLE trip_location_samples DISABLE TRIGGER accept_trip_location_sample");
    const now = new Date();
    const at = (minutes: number) => new Date(now.getTime() + minutes * MIN);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const clock = (dayOffset: number, h: number, m: number) =>
      new Date(today.getTime() + dayOffset * 1440 * MIN + (h * 60 + m) * MIN);

    const password = await hashPassword("demo-password-123");
    const [admin] = await q<{ id: string }>("SELECT id FROM members WHERE username = 'admin'");
    const staff: Record<string, string> = {};
    for (const name of staffNames) {
      const username = name.toLowerCase().replace(" ", "_");
      const [member] = await q<{ id: string }>(
        `INSERT INTO members (username, display_name, email, password_hash, activated_at, password_change_required)
         VALUES ($1, $2, $3, $4, now(), false) RETURNING id`,
        [username, name, `${username}@example.com`, password]
      );
      await q("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [member.id]);
      staff[name] = member.id;
    }
    const [setup] = await q<{ id: string }>(
      `INSERT INTO members (username, display_name, password_hash, activated_at, password_change_required)
       VALUES ('ewalsh', 'Erin Walsh', $1, now(), true) RETURNING id`, [password]
    );
    await q("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [setup.id]);
    const [suspended] = await q<{ id: string }>(
      `INSERT INTO members (username, display_name, password_hash, activated_at, suspended_at)
       VALUES ('oclarke', 'Owen Clarke', $1, now(), now()) RETURNING id`, [password]
    );
    await q("INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')", [suspended.id]);
    const actor = admin?.id ?? staff["Sam Okafor"];

    const buses: string[] = [];
    for (let n = 1; n <= 7; n += 1) {
      const [bus] = await q<{ id: string }>(
        "INSERT INTO buses (label, active) VALUES ($1, $2) RETURNING id", [`Bus ${n}`, n !== 7]
      );
      buses.push(bus.id);
    }

    const routes: Record<string, { AM: string; PM: string }> = {};
    for (const spec of routeSpecs) {
      const [family] = await q<{ id: string }>(
        "INSERT INTO route_families (name) VALUES ($1) RETURNING id", [spec.family]
      );
      routes[spec.family] = { AM: "", PM: "" };
      for (const period of ["AM", "PM"] as const) {
        const [route] = await q<{ id: string }>(
          `INSERT INTO routes (name, route_family_id, service_period) VALUES ($1, $2, $3) RETURNING id`,
          [`${spec.family} ${period}`, family.id, period]
        );
        routes[spec.family][period] = route.id;
        const ordered = period === "AM" ? spec.stops : [...spec.stops].reverse();
        for (const [index, [label, lat, lng]] of ordered.entries()) {
          await q(
            `INSERT INTO route_stops (route_id, position, label, latitude, longitude) VALUES ($1, $2, $3, $4, $5)`,
            [route.id, index + 1, label, lat, lng]
          );
        }
      }
    }

    // Riders, guardians, AM + PM assignments at their home stop.
    let phone = 111;
    for (const spec of routeSpecs) {
      for (const [index, name] of kids[spec.family].entries()) {
        const [given, family] = name.split(" ");
        const [rider] = await q<{ id: string }>(
          "INSERT INTO riders (given_name, family_name) VALUES ($1, $2) RETURNING id", [given, family]
        );
        const existing = await q<{ id: string }>(
          "SELECT g.id FROM guardians g WHERE g.name LIKE $1 LIMIT 1", [`% ${family}`]
        );
        const guardianId = existing[0]?.id ?? (await q<{ id: string }>(
          `INSERT INTO guardians (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
          [`${["Maria", "Carlos", "Priya", "James", "Aisha", "Tom", "Linda"][index % 7]} ${family}`,
           index % 4 === 3 ? null : `${family.toLowerCase()}.family@example.com`,
           `973-555-0${phone++}`]
        ))[0].id;
        await q("INSERT INTO rider_guardian_links (rider_id, guardian_id, source) VALUES ($1, $2, 'manual')",
          [rider.id, guardianId]);
        const home = index % (spec.stops.length - 1);
        for (const period of ["AM", "PM"] as const) {
          const position = period === "AM" ? home + 1 : spec.stops.length - home;
          await q(
            `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id)
             SELECT $1, $2, route_id, id FROM route_stops WHERE route_id = $3 AND position = $4`,
            [rider.id, period, routes[spec.family][period], position]
          );
        }
      }
    }
    await q(`INSERT INTO riders (given_name, family_name) VALUES ('Leo', 'Becker')`);

    const S = staff;
    // Yesterday: a full day, one cancelled trip.
    for (const [bus, family, staffName, h, m, delay, period] of [
      [0, "Maplewood North", "Dana Reyes", 7, 45, 0, "AM"], [1, "South Orange Village", "Marcus Tull", 7, 50, 3, "AM"],
      [2, "Millburn Loop", "Priya Shah", 8, 0, 0, "AM"], [0, "Maplewood North", "Dana Reyes", 14, 26, 0, "PM"],
      [1, "South Orange Village", "Marcus Tull", 14, 18, 6, "PM"]
    ] as const) {
      const departureAt = clock(-1, h, m);
      const tripId = await createTrip(client, { routeId: routes[family][period], busId: buses[bus], departureAt, staffId: S[staffName] });
      const { stops } = await runTrip(client, { tripId, staffId: S[staffName], startedAt: new Date(departureAt.getTime() + delay * MIN),
        stopsDone: 99, arrivedAtCurrent: true, complete: true, manualStops: bus === 1 ? [1] : [], gpsUntil: new Date(departureAt.getTime() + 20 * MIN), now });
      void stops;
    }
    const cancelled = await createTrip(client, { routeId: routes["Short Hills"].PM, busId: buses[3], departureAt: clock(-1, 14, 54), staffId: S["Luis Moreno"] });
    await q(`UPDATE trips SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`, [cancelled, clock(-1, 14, 20)]);
    await q(`INSERT INTO trip_events (trip_id, event_type, recorded_by, occurred_at, note) VALUES ($1, 'cancelled', $2, $3, 'Driver out sick')`, [cancelled, actor, clock(-1, 14, 20)]);

    // Today AM: completed.
    const amTrips: Record<string, string> = {};
    for (const [bus, family, staffName, before] of [
      [0, "Maplewood North", "Dana Reyes", 330], [1, "South Orange Village", "Marcus Tull", 320],
      [2, "Millburn Loop", "Priya Shah", 335], [3, "Short Hills", "Luis Moreno", 325]
    ] as const) {
      const departureAt = at(-before);
      const tripId = await createTrip(client, { routeId: routes[family].AM, busId: buses[bus], departureAt, staffId: S[staffName] });
      await runTrip(client, { tripId, staffId: S[staffName], startedAt: departureAt, stopsDone: 99, arrivedAtCurrent: true,
        complete: true, gpsUntil: new Date(departureAt.getTime() + 25 * MIN), now, manualStops: bus === 2 ? [0] : [],
        gapSeconds: bus === 2 ? 130 : 0 });
      amTrips[family] = tripId;
      // Ride check: everyone boarded and got off at camp, except scripted exceptions.
      for (const [index, kid] of kids[family].entries()) {
        const boardAt = new Date(departureAt.getTime() + (3 + index * 2) * MIN);
        if (family === "South Orange Village" && kid === "Finn Murphy") {
          await check(tripId, kid, "no_show", boardAt, S[staffName]);
          continue;
        }
        await check(tripId, kid, "boarded", boardAt, S[staffName]);
        await check(tripId, kid, "dropped_off", new Date(departureAt.getTime() + 36 * MIN), S[staffName]);
      }
      if (family !== "Short Hills") {
        await q("INSERT INTO trip_sweeps (trip_id, recorded_by, occurred_at) VALUES ($1, $2, $3)",
          [tripId, S[staffName], new Date(departureAt.getTime() + 38 * MIN)]);
      }
    }

    // Today PM: two live, one stale GPS, one late with no driver, one later.
    const pm = async (bus: number, family: string, staffName: string | null, minutesAgo: number, stopsDone: number,
      arrived: boolean, gpsSilentFor: number | null) => {
      const departureAt = at(-minutesAgo);
      const tripId = await createTrip(client, { routeId: routes[family].PM, busId: buses[bus], departureAt,
        staffId: staffName ? S[staffName] : null });
      if (gpsSilentFor === null || !staffName) return tripId;
      await runTrip(client, { tripId, staffId: S[staffName], startedAt: departureAt, stopsDone, arrivedAtCurrent: arrived,
        complete: false, gpsUntil: at(-gpsSilentFor), now });
      await q(`INSERT INTO staff_presence (member_id, last_seen_at) VALUES ($1, $2)
               ON CONFLICT (member_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
        [S[staffName], at(-gpsSilentFor)]);
      // PM: everyone boards at camp, then gets off at their stop as the bus passes it.
      const stops = await q<{ id: string; position: number }>(
        "SELECT id, position FROM trip_stops WHERE trip_id = $1", [tripId]);
      const riders = await q<{ riderId: string; name: string; stopId: string }>(
        `SELECT tr.rider_id AS "riderId", r.given_name || ' ' || r.family_name AS name, tr.trip_stop_id AS "stopId"
           FROM trip_riders tr JOIN riders r ON r.id = tr.rider_id WHERE tr.trip_id = $1`, [tripId]);
      for (const rider of riders) {
        await check(tripId, rider.name, "boarded", new Date(departureAt.getTime() + 2 * MIN), S[staffName]);
        const position = stops.find((stop) => stop.id === rider.stopId)!.position;
        if (position <= stopsDone && !(family === "South Orange Village" && rider.name === "Ife Okafor")) {
          await check(tripId, rider.name, "dropped_off", new Date(departureAt.getTime() + (3 + position * 7) * MIN), S[staffName]);
        }
      }
      return tripId;
    };
    await pm(0, "Maplewood North", "Dana Reyes", 14, 2, false, 0);
    await pm(1, "South Orange Village", "Marcus Tull", 22, 3, true, 0);
    await pm(2, "Millburn Loop", "Priya Shah", 31, 3, false, 3);
    await pm(3, "Short Hills", "Luis Moreno", -14, 0, false, null);
    await pm(4, "Livingston Express", null, 3, 0, false, null);
    const later = await pm(5, "Livingston Express", "Ana Ortiz", -95, 0, false, null);
    await check(later, "Tara Singh", "not_riding", at(-60), actor);
    // Tomorrow
    await createTrip(client, { routeId: routes["Maplewood North"].AM, busId: buses[0], departureAt: clock(1, 7, 45), staffId: S["Dana Reyes"] });
    await createTrip(client, { routeId: routes["Millburn Loop"].AM, busId: buses[2], departureAt: clock(1, 8, 0), staffId: null });

    await client.query("ALTER TABLE trip_location_samples ENABLE TRIGGER accept_trip_location_sample");
    await client.query("COMMIT");
    console.log("Demo data created. Staff password: demo-password-123");
  }

  if (live) {
    console.log("Live mode: running buses report GPS every 5 seconds. Ctrl-C to stop.");
    const tick = async () => {
      const trips = await q<{ id: string; memberId: string; lat: number; lng: number }>(
        `SELECT t.id, a.member_id AS "memberId", s.latitude::float8 AS lat, s.longitude::float8 AS lng
           FROM trips t
           JOIN staff_assignments a ON a.trip_id = t.id AND a.ended_at IS NULL
           JOIN trip_current_locations c ON c.trip_id = t.id
           JOIN trip_location_samples s ON s.id = c.sample_id
          WHERE t.status = 'active' AND c.observed_at > now() - interval '45 seconds'`
      );
      for (const trip of trips) {
        await q(
          `INSERT INTO trip_location_samples
             (trip_id, member_id, client_sample_id, observed_at, latitude, longitude, accuracy_m, speed_mps, heading_degrees)
           VALUES ($1, $2, $3, now(), $4, $5, 7, 6.5, 45)`,
          [trip.id, trip.memberId, randomUUID(), trip.lat + 0.00008, trip.lng + 0.00012]
        );
        await q(`INSERT INTO staff_presence (member_id, last_seen_at) VALUES ($1, now())
                 ON CONFLICT (member_id) DO UPDATE SET last_seen_at = now()`, [trip.memberId]);
      }
    };
    await tick();
    const timer = setInterval(() => { void tick().catch((error) => console.error(error)); }, 5_000);
    process.on("SIGINT", () => { clearInterval(timer); client.release(); void pool.end().then(() => process.exit(0)); });
    process.on("SIGTERM", () => { clearInterval(timer); client.release(); void pool.end().then(() => process.exit(0)); });
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  if (!live) {
    client.release();
    await pool.end();
  }
}
