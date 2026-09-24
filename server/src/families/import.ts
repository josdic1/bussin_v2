import { readFile } from "node:fs/promises";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import type { PoolClient } from "pg";

const key = z.string().trim().min(1).max(120);
const name = z.string().trim().min(1).max(120);
const assignment = z.strictObject({ route: name, stop: name }).nullable();
const guardian = z.strictObject({
  key, name, email: z.string().trim().toLowerCase().pipe(z.email()).nullable(),
  phone: z.string().trim().max(40).nullable()
});
const fileSchema = z.strictObject({
  dataset: key,
  riders: z.array(z.strictObject({
    key, givenName: z.string().trim().min(1).max(80),
    familyName: z.string().trim().min(1).max(80),
    guardians: z.array(guardian).min(1).max(10),
    am: assignment, pm: assignment
  })).min(1)
});
type Roster = z.infer<typeof fileSchema>;
type Link = { routeId: string; stopId: string } | null;

function validateKeys(data: Roster) {
  const riders = new Set<string>();
  const guardians = new Map<string, string>();
  for (const rider of data.riders) {
    if (riders.has(rider.key)) throw new Error(`Duplicate rider key: ${rider.key}`);
    riders.add(rider.key);
    const linked = new Set<string>();
    for (const guardian of rider.guardians) {
      if (linked.has(guardian.key)) throw new Error(`Duplicate guardian ${guardian.key} for rider ${rider.key}`);
      linked.add(guardian.key);
      const details = JSON.stringify([guardian.name, guardian.email, guardian.phone]);
      if (guardians.has(guardian.key) && guardians.get(guardian.key) !== details) {
        throw new Error(`Guardian key ${guardian.key} has conflicting contact details`);
      }
      guardians.set(guardian.key, details);
    }
  }
  return guardians.size;
}

async function resolve(client: PoolClient, data: Roster) {
  const routes = await client.query<{
    routeName: string; stopLabel: string; routeId: string; stopId: string; active: boolean;
  }>(`SELECT r.name AS "routeName", s.label AS "stopLabel", r.id AS "routeId",
              s.id AS "stopId", r.active
         FROM routes r JOIN route_stops s ON s.route_id = r.id`);
  const linked = new Map<string, { am: Link; pm: Link }>();
  for (const rider of data.riders) {
    const resolveStop = (direction: "am" | "pm"): Link => {
      const target = rider[direction];
      if (!target) return null;
      const matches = routes.rows.filter((row) => row.routeName === target.route && row.stopLabel === target.stop && row.active);
      if (matches.length !== 1) throw new Error(`${rider.key} ${direction.toUpperCase()}: expected one active stop ${target.route} / ${target.stop}, found ${matches.length}`);
      return { routeId: matches[0].routeId, stopId: matches[0].stopId };
    };
    linked.set(rider.key, { am: resolveStop("am"), pm: resolveStop("pm") });
  }
  const existing = await client.query<{ importKey: string }>(
    `SELECT import_key AS "importKey" FROM riders WHERE import_dataset = $1`, [data.dataset]);
  const missing = existing.rows.map((row) => row.importKey).filter((item) => !linked.has(item));
  if (missing.length) throw new Error(`Import omits ${missing.length} existing rider key(s) in ${data.dataset}: ${missing.join(", ")}. No records were changed.`);
  return linked;
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if ((mode !== "preview" && mode !== "apply") || !path || process.argv.length !== 4) {
    throw new Error("Usage: npm run roster:import -w @bussin/server -- preview|apply path/to/roster.json");
  }
  const data = fileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const guardianCount = validateKeys(data);
  const tenant = await readTenant();
  if (data.dataset !== tenant.key) {
    throw new Error(`Roster dataset ${data.dataset} does not match this database (${tenant.key}).`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(472902)");
    const linked = await resolve(client, data);
    console.log(`Dataset ${data.dataset}: ${data.riders.length} riders, ${guardianCount} guardians, ${data.riders.filter((r) => linked.get(r.key)?.am).length} AM, ${data.riders.filter((r) => linked.get(r.key)?.pm).length} PM assignments`);
    if (mode === "preview") {
      for (const rider of data.riders) {
        console.log(`${rider.key}: ${rider.givenName} ${rider.familyName} | ${rider.am ? `${rider.am.route} / ${rider.am.stop}` : "no AM"} | ${rider.pm ? `${rider.pm.route} / ${rider.pm.stop}` : "no PM"}`);
      }
      await client.query("ROLLBACK");
      console.log("Preview only: database unchanged.");
      return;
    }
    for (const rider of data.riders) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO riders (import_dataset, import_key, given_name, family_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (import_dataset, import_key) WHERE import_dataset IS NOT NULL
         DO UPDATE SET given_name = EXCLUDED.given_name, family_name = EXCLUDED.family_name
         RETURNING id`, [data.dataset, rider.key, rider.givenName, rider.familyName]);
      const riderId = result.rows[0].id;
      await client.query("DELETE FROM rider_guardian_links WHERE rider_id = $1 AND source = 'import'", [riderId]);
      for (const person of rider.guardians) {
        const saved = await client.query<{ id: string }>(
          `INSERT INTO guardians (import_dataset, import_key, name, email, phone)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (import_dataset, import_key)
             WHERE import_dataset IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone
           RETURNING id`, [data.dataset, person.key, person.name, person.email, person.phone]);
        await client.query(
          `INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
           VALUES ($1, $2, 'import')
           ON CONFLICT (rider_id, guardian_id) DO NOTHING`, [riderId, saved.rows[0].id]
        );
      }
      await client.query("DELETE FROM rider_stop_assignments WHERE rider_id = $1", [riderId]);
      const assignments = linked.get(rider.key)!;
      for (const direction of ["am", "pm"] as const) {
        const stop = assignments[direction];
        if (stop) await client.query(
          `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id)
           VALUES ($1, $2, $3, $4)`, [riderId, direction.toUpperCase(), stop.routeId, stop.stopId]);
      }
    }
    await client.query("COMMIT");
    console.log("Roster imported. Reapplying the same file updates these keyed records without duplicating them.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
