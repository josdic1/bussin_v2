import type { PoolClient } from "pg";
import { LINE_COLORS } from "@bussin/shared";
import { hashPassword } from "../auth/sessions.js";
import { resetAllButAdmins } from "../admin/reset.js";
import { createRoute } from "../routes/save.js";
import { ADULT_FIRST, fakePhone, KID_FIRST, LAST, pick } from "./names.js";
import { resetDemo } from "./reset.js";

/*
 * Build a whole made-up camp in one go: buses, lines (a town to camp in the morning and
 * back in the afternoon), counselors, drivers, kids and parents, and the repeating
 * schedule. Sized to what the visitor asked for. Uses the same tables and the same route
 * code as the real app, so everything after this is the real product.
 */

export type CampSize = { campName: string; buses: number; kids: number };

/** The camp sits in the middle; each line starts in one of these towns. */
const CAMP = { label: "Camp", latitude: 40.7780, longitude: -74.2890 };
const TOWNS: [string, number, number][] = [
  ["Maplewood", 40.7312, -74.2735], ["South Orange", 40.7489, -74.2610], ["Millburn", 40.7248, -74.3031],
  ["Livingston", 40.7959, -74.3149], ["West Orange", 40.7987, -74.2390], ["Montclair", 40.8259, -74.2090],
  ["Summit", 40.7157, -74.3646], ["Short Hills", 40.7430, -74.3280], ["Verona", 40.8298, -74.2404],
  ["Caldwell", 40.8398, -74.2765], ["Chatham", 40.7409, -74.3838], ["Springfield", 40.7043, -74.3171],
  ["Roseland", 40.8209, -74.2937], ["Cedar Grove", 40.8517, -74.2290], ["Union", 40.6976, -74.2632],
  ["Madison", 40.7598, -74.4171]
];

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export async function buildCamp(client: PoolClient, size: CampSize) {
  const buses = Math.max(1, Math.min(TOWNS.length, Math.round(size.buses)));
  const kids = Math.max(buses, Math.min(600, Math.round(size.kids)));
  await resetAllButAdmins(client);

  const admin = (await client.query<{ id: string }>(
    `SELECT member_id AS id FROM member_roles WHERE role = 'admin' AND revoked_at IS NULL LIMIT 1`)).rows[0];
  if (!admin) throw new Error("The demo has no admin login.");
  const password = await hashPassword(process.env.DEMO_PASSWORD ?? "bussin-demo");

  // The camp's name shows in every header. Locked normally; the demo may rename itself.
  await client.query(`ALTER TABLE tenant_identity DISABLE TRIGGER tenant_identity_immutable`);
  await client.query(`UPDATE tenant_identity SET display_name = $1 WHERE singleton = true`, [size.campName.trim().slice(0, 80) || "Demo Camp"]);
  await client.query(`ALTER TABLE tenant_identity ENABLE TRIGGER tenant_identity_immutable`);

  let person = 0;
  const staffMember = async (role: "staff") => {
    person++;
    const first = pick(ADULT_FIRST, person * 5 + 1), last = pick(LAST, person * 7 + 3);
    const username = `${first}_${last}${person}`.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
    const made = await client.query<{ id: string }>(
      `INSERT INTO members (username, display_name, email, phone, password_hash, activated_at, password_change_required)
       VALUES ($1, $2, $3, $4, $5, now(), false) RETURNING id`,
      [username, `${first} ${last}`, `${username}@example.com`, fakePhone(700 + person), password]);
    await client.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, $2)`, [made.rows[0]!.id, role]);
    return made.rows[0]!.id;
  };

  const lines: { amStops: string[]; pmStops: string[]; amRoute: string; pmRoute: string }[] = [];
  for (let n = 0; n < buses; n++) {
    const [town, lat, lng] = TOWNS[n]!;
    const bus = await client.query<{ id: string }>(
      `INSERT INTO buses (label, plate, company, seats, inspection_due, insurance_expires)
       VALUES ($1, $2, 'Demo Coach Lines', 48, $3, $4) RETURNING id`,
      [`Bus ${n + 1}`, `DEMO ${101 + n}`, day(120 + n * 9), day(200 + n * 7)]);
    const driver = await client.query<{ id: string }>(
      `INSERT INTO drivers (name, phone) VALUES ($1, $2) RETURNING id`,
      [`${pick(ADULT_FIRST, n * 9 + 4)} ${pick(LAST, n * 11 + 6)}`, fakePhone(900 + n)]);
    const lead = await staffMember("staff");
    const counselor = await staffMember("staff");

    // Two pickups in town (the center, then a second spot partway to camp), then camp.
    const center = { label: `${town} Center`, latitude: lat, longitude: lng };
    const second = {
      label: `${town} ${pick(["Library", "Station", "Park", "School", "Plaza"], n)}`,
      latitude: Number((lat + (CAMP.latitude - lat) * 0.35 + 0.002).toFixed(6)),
      longitude: Number((lng + (CAMP.longitude - lng) * 0.35 - 0.002).toFixed(6))
    };
    const am = await createRoute(client, { name: `${town} AM`, familyName: town, servicePeriod: "AM", stops: [center, second, CAMP] });
    const pm = await createRoute(client, { name: `${town} PM`, familyName: town, servicePeriod: "PM", stops: [CAMP, second, center] });
    await client.query(`UPDATE route_families SET color = $2 WHERE id = $1`, [am.routeFamilyId, LINE_COLORS[n % LINE_COLORS.length]]);
    lines.push({
      amRoute: am.id, pmRoute: pm.id,
      amStops: am.stops.slice(0, 2).map((stop) => stop.id),      // the two town stops, in pickup order
      pmStops: pm.stops.slice(1).reverse().map((stop) => stop.id) // the same two stops on the way home
    });

    // A season around today, so there is history behind and trips ahead.
    for (const [routeId, time] of [[am.id, hhmm(7 * 60 + 40 + (n % 6) * 5)], [pm.id, hhmm(15 * 60 + 30 + (n % 4) * 5)]] as const) {
      await client.query(
        `INSERT INTO trip_schedules (route_id, bus_id, weekdays, depart_time, starts_on, ends_on, lead_id, counselor_ids, driver_id, created_by)
         VALUES ($1, $2, '{1,2,3,4,5}', $3, $4, $5, $6, $7, $8, $9)`,
        [routeId, bus.rows[0]!.id, time, day(-63), day(28), lead, [counselor], driver.rows[0]!.id, admin.id]);
    }
  }

  // Families of one to three kids. Most parents have their login set up; a few haven't yet.
  let made = 0, family = 0, guardianCount = 0;
  while (made < kids) {
    family++;
    const last = pick(LAST, family * 3 + Math.floor(family / LAST.length));
    const size = Math.min(kids - made, 1 + (family % 5 === 0 ? 2 : family % 3 === 0 ? 1 : 0));
    const line = lines[(family - 1) % lines.length]!;
    const stopIndex = family % 2;
    const parents: string[] = [];
    for (let p = 0; p < (family % 4 === 0 ? 1 : 2); p++) {
      guardianCount++;
      const first = pick(ADULT_FIRST, guardianCount * 7 + p);
      const email = `${first}.${last}${guardianCount}`.toLowerCase().replace(/[^a-z0-9.]/g, "") + "@example.com";
      let memberId: string | null = null;
      if (guardianCount % 6 !== 0) {
        const member = await client.query<{ id: string }>(
          `INSERT INTO members (email, display_name, password_hash, activated_at, password_change_required)
           VALUES ($1, $2, $3, now(), false) RETURNING id`, [email, `${first} ${last}`, password]);
        memberId = member.rows[0]!.id;
        await client.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, 'family')`, [memberId]);
      }
      const guardian = await client.query<{ id: string }>(
        `INSERT INTO guardians (name, email, phone, member_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`${first} ${last}`, email, fakePhone(guardianCount), memberId]);
      parents.push(guardian.rows[0]!.id);
    }
    for (let k = 0; k < size; k++) {
      made++;
      const partWeek = made % 7 === 0 ? [1, 3, 5] : made % 11 === 0 ? [2, 4] : null;
      const rider = await client.query<{ id: string }>(
        `INSERT INTO riders (given_name, family_name, ride_days, emergency_name, emergency_phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [pick(KID_FIRST, made * 11 + family), last, partWeek, `${pick(ADULT_FIRST, made * 13)} ${pick(LAST, made * 17)}`, fakePhone(500 + made)]);
      for (const guardian of parents) {
        await client.query(`INSERT INTO rider_guardian_links (rider_id, guardian_id, source) VALUES ($1, $2, 'manual')`, [rider.rows[0]!.id, guardian]);
      }
      await client.query(
        `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, 'AM', $2, $3), ($1, 'PM', $4, $5)`,
        [rider.rows[0]!.id, line.amRoute, line.amStops[stopIndex], line.pmRoute, line.pmStops[stopIndex]]);
    }
  }

  // Today's run leaves in a few minutes; the rest of the two weeks is planned like any camp.
  const runs = await resetDemo(client, "AM");
  return { buses, kids: made, families: family, staff: person, runs, routeIds: lines.flatMap((line) => [line.amRoute, line.pmRoute]) };
}
