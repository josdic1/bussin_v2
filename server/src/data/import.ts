import { createHash } from "node:crypto";
import express, { Router } from "express";
import type { PoolClient } from "pg";
import {
  formatPhone, rosterImportInputSchema, rosterImportPreviewSchema, rosterImportResultSchema,
  type RosterImportInput, type RosterImportItem
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { syncPlannedTripRiders } from "../families/access.js";

// Roster CSV import for Data mode. Reads the same columns "Download CSV" writes:
//   Rider key | First | Last | AM route | AM stop | PM route | PM stop |
//   Guardian 1 | Guardian 1 phone | Guardian 1 email | Guardian 2 ...
// "Source" and "app access" columns are ignored.
//
// Two calls, same planner:
//   POST /preview  plans every change and writes nothing.
//   POST /apply    plans again, refuses if anything differs from the preview, then writes it all
//                  in one transaction. Either every good row lands or nothing does.
//
// Rules, kept simple and visible in the preview:
//   - Rider key matches an existing rider. With no key, a rider with the exact same first and
//     last name is matched (so uploading the same file twice never makes duplicates);
//     otherwise a new rider is added.
//   - Riders not in the file are left alone. Nothing is ever deleted.
//   - Riders imported from a roster file are skipped (change them in that file).
//   - Route and stop are matched by name on active AM/PM routes. Both blank = no bus.
//   - A guardian is matched by email, then phone, then exact name. Otherwise a new guardian
//     is added. Siblings listing the same parent share one guardian.
//   - The guardians listed become the rider's guardians. Unlisted ones are unlinked
//     (contacts are kept). A row with no guardians leaves links alone.
//   - Rows with a problem are listed with the reason and skipped; the rest can still be applied.

type Guardian = { id: string; name: string; email: string | null; phone: string | null };
type Stop = { routeId: string; stopId: string; label: string };
type GuardianWant = { name: string; email: string | null; phone: string | null };
type GuardianPick =
  | { kind: "existing"; id: string; update: Partial<GuardianWant> }
  | { kind: "new"; ref: number };

type Action = {
  line: number;
  riderId: string | null;
  first: string;
  last: string;
  am: Stop | null | undefined; // undefined = no change
  pm: Stop | null | undefined;
  guardians: GuardianPick[] | null; // null = leave links alone
  unlink: string[];
};

type Plan = { items: RosterImportItem[]; actions: Action[]; newGuardians: GuardianWant[]; missing: string[] };

// ---------- Reading the file ----------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "");
// Our own export guards formula-looking cells with a leading apostrophe; undo that.
const clean = (s: string | undefined) => (s ?? "").replace(/^'(?=[=+\-@])/, "").trim();

const HEADERS: Record<string, string[]> = {
  key: ["rider key", "key", "rider id", "id"],
  first: ["first", "first name", "given name"],
  last: ["last", "last name", "family name", "surname"],
  amRoute: ["am route"], amStop: ["am stop"],
  pmRoute: ["pm route"], pmStop: ["pm stop"]
};

function mapHeaders(headers: string[]) {
  const at = (names: string[]) => headers.findIndex((h) => names.includes(norm(h)));
  const index: Record<string, number> = {};
  for (const [field, names] of Object.entries(HEADERS)) index[field] = at(names);
  const guardians: { name: number; phone: number; email: number }[] = [];
  for (let n = 1; n <= 10; n += 1) {
    const name = at([`guardian ${n}`, `guardian ${n} name`]);
    if (name < 0) continue;
    guardians.push({ name, phone: at([`guardian ${n} phone`]), email: at([`guardian ${n} email`]) });
  }
  const missing = ["first", "last"].filter((f) => index[f] < 0).map((f) => (f === "first" ? "First" : "Last"));
  return { index, guardians, missing };
}

// ---------- Planning ----------

async function plan(client: PoolClient, input: RosterImportInput): Promise<Plan> {
  const { index, guardians: gcols, missing } = mapHeaders(input.headers);
  const items: RosterImportItem[] = [];
  const actions: Action[] = [];
  const newGuardians: GuardianWant[] = [];
  if (missing.length) return { items, actions, newGuardians, missing };

  const riders = new Map((await client.query<{
    id: string; first: string; last: string; imported: boolean;
  }>(`SELECT id, given_name AS first, family_name AS last, import_dataset IS NOT NULL AS imported FROM riders`)).rows
    .map((r) => [r.id, r]));
  const assigned = new Map((await client.query<{ riderId: string; direction: "AM" | "PM"; routeId: string; stopId: string }>(
    `SELECT rider_id AS "riderId", direction, route_id AS "routeId", route_stop_id AS "stopId" FROM rider_stop_assignments`
  )).rows.map((a) => [`${a.riderId}|${a.direction}`, a]));
  const stops = (await client.query<{ period: "AM" | "PM"; route: string; stop: string; routeId: string; stopId: string }>(
    `SELECT r.service_period AS period, r.name AS route, s.label AS stop, r.id AS "routeId", s.id AS "stopId"
       FROM route_stops s JOIN routes r ON r.id = s.route_id
      WHERE r.active AND r.superseded_at IS NULL`
  )).rows;
  const allGuardians = (await client.query<Guardian>(`SELECT id, name, email, phone FROM guardians`)).rows;
  const links = (await client.query<{ riderId: string; guardianId: string; source: string }>(
    `SELECT rider_id AS "riderId", guardian_id AS "guardianId", source FROM rider_guardian_links`
  )).rows;
  const byId = new Map(allGuardians.map((g) => [g.id, g]));

  const seenKeys = new Set<string>();

  const findStop = (period: "AM" | "PM", route: string, stop: string): Stop | null | string => {
    if (!route && !stop) return null;
    if (!route) return `${period} stop "${stop}" has no ${period} route next to it.`;
    const onRoute = stops.filter((s) => s.period === period && norm(s.route) === norm(route));
    if (!onRoute.length) return `No active ${period} route called "${route}".`;
    if (!stop) return `${period} route "${route}" needs a stop.`;
    const hit = onRoute.find((s) => norm(s.stop) === norm(stop));
    if (!hit) return `"${stop}" isn't a stop on ${period} route "${route}".`;
    return { routeId: hit.routeId, stopId: hit.stopId, label: `${hit.route} · ${hit.stop}` };
  };

  const matchGuardian = (want: GuardianWant, riderId: string | null): GuardianPick | string => {
    // Already added earlier in this same file (siblings).
    const earlier = newGuardians.findIndex((g) =>
      (want.email && g.email === want.email) || (digits(want.phone).length >= 7 && digits(g.phone) === digits(want.phone)) ||
      (!want.email && !want.phone && norm(g.name) === norm(want.name)));
    const fromDb = (list: Guardian[]) => list.length === 1 ? list[0] : list.length > 1 ? "many" : null;
    let hit: Guardian | "many" | null = null;
    if (want.email) hit = fromDb(allGuardians.filter((g) => g.email === want.email));
    if (!hit && digits(want.phone).length >= 7) hit = fromDb(allGuardians.filter((g) => digits(g.phone) === digits(want.phone)));
    if (!hit) {
      const mine = riderId ? links.filter((l) => l.riderId === riderId).map((l) => byId.get(l.guardianId)!).filter(Boolean) : [];
      hit = fromDb(mine.filter((g) => norm(g.name) === norm(want.name)))
        ?? fromDb(allGuardians.filter((g) => norm(g.name) === norm(want.name)));
    }
    if (hit === "many") return `More than one guardian matches "${want.name}". Add an email or phone to tell them apart.`;
    if (hit) {
      const update: Partial<GuardianWant> = {};
      if (want.name && want.name !== hit.name) update.name = want.name;
      if (want.email && want.email !== hit.email) {
        const owner = allGuardians.find((g) => g.id !== (hit as Guardian).id && g.email === want.email);
        if (owner) return `${want.email} already belongs to ${owner.name}. Each parent needs their own email.`;
        update.email = want.email;
      }
      if (want.phone && want.phone !== hit.phone) update.phone = want.phone;
      return { kind: "existing", id: hit.id, update };
    }
    if (earlier >= 0) return { kind: "new", ref: earlier };
    newGuardians.push(want);
    return { kind: "new", ref: newGuardians.length - 1 };
  };

  input.rows.forEach((cells, i) => {
    const line = i + 2; // line 1 is the header row
    const get = (field: string) => (index[field] >= 0 ? clean(cells[index[field]]) : "");
    if (cells.every((c) => !clean(c))) return; // blank line
    const first = get("first");
    const last = get("last");
    const name = `${first} ${last}`.trim() || `Line ${line}`;
    const fail = (error: string) => items.push({ line, rider: name, kind: "error", changes: [], error });

    const key = get("key");
    if (key && seenKeys.has(key)) return fail("This rider key appears twice in the file.");
    if (key) seenKeys.add(key);
    let existing = key ? riders.get(key) : undefined;
    if (key && !existing) return fail("No rider has this Rider key. Leave it blank to add a new rider.");
    let matchedByName = false;
    if (!key && first && last) {
      const same = [...riders.values()].filter((r) => norm(r.first) === norm(first) && norm(r.last) === norm(last));
      if (same.length > 1) return fail(`There are ${same.length} riders named ${first} ${last}. Add the Rider key from Download CSV.`);
      if (same.length === 1) {
        existing = same[0];
        matchedByName = true;
        if (seenKeys.has(existing!.id)) return fail("This rider appears twice in the file.");
        seenKeys.add(existing!.id);
      }
    }
    if (!first || !last) return fail("First and Last are both required.");
    if (first.length > 80 || last.length > 80) return fail("Names must be under 80 characters.");

    const am = findStop("AM", get("amRoute"), get("amStop"));
    if (typeof am === "string") return fail(am);
    const pm = findStop("PM", get("pmRoute"), get("pmStop"));
    if (typeof pm === "string") return fail(pm);

    // Guardians listed on this row.
    const wants: GuardianWant[] = [];
    for (const g of gcols) {
      const gname = clean(cells[g.name]);
      const email = g.email >= 0 ? clean(cells[g.email]).toLowerCase() || null : null;
      const rawPhone = g.phone >= 0 ? clean(cells[g.phone]) : "";
      const formatted = formatPhone(rawPhone);
      if (!formatted.ok) return fail(`${gname || "A guardian"}'s phone "${rawPhone}": ${formatted.error}`);
      const phone = formatted.value;
      if (!gname && !email && !phone) continue;
      if (!gname) return fail("A guardian has a phone or email but no name.");
      if (gname.length > 120) return fail("Guardian names must be under 120 characters.");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(`"${email}" isn't a valid email.`);
      wants.push({ name: gname, email, phone });
    }
    if (!existing && !wants.length) return fail("A new rider needs at least one guardian.");

    const before = newGuardians.length;
    const picks: GuardianPick[] = [];
    for (const want of wants) {
      const pick = matchGuardian(want, existing?.id ?? null);
      if (typeof pick === "string") { newGuardians.length = before; return fail(pick); }
      if (!picks.some((p) => p.kind === "existing" && pick.kind === "existing" && p.id === pick.id)) picks.push(pick);
    }

    // Describe the changes in plain words.
    const changes: string[] = [];
    if (existing && existing.first !== first) changes.push(`First: ${existing.first} → ${first}`);
    if (existing && existing.last !== last) changes.push(`Last: ${existing.last} → ${last}`);
    const stopChange = (period: "AM" | "PM", want: Stop | null): Stop | null | undefined => {
      const now = existing ? assigned.get(`${existing.id}|${period}`) : undefined;
      if (!now && !want) return undefined;
      if (now && want && now.stopId === want.stopId) return undefined;
      changes.push(want ? `${period}: ${want.label}` : `${period}: no bus`);
      return want;
    };
    const amChange = stopChange("AM", am);
    const pmChange = stopChange("PM", pm);

    let unlink: string[] = [];
    if (picks.length) {
      const keep = new Set(picks.filter((p) => p.kind === "existing").map((p) => (p as { id: string }).id));
      const current = existing ? links.filter((l) => l.riderId === existing.id) : [];
      for (const p of picks) {
        if (p.kind === "new") changes.push(`Add new guardian ${newGuardians[p.ref]!.name}`);
        else {
          const g = byId.get(p.id)!;
          if (!current.some((l) => l.guardianId === p.id)) changes.push(`Link guardian ${g.name}`);
          const u = p.update;
          if (u.name) changes.push(`Guardian ${g.name} name → ${u.name}`);
          if (u.email) changes.push(`${g.name} email → ${u.email}`);
          if (u.phone) changes.push(`${g.name} phone → ${u.phone}`);
        }
      }
      unlink = current.filter((l) => !keep.has(l.guardianId)).map((l) => l.guardianId);
      for (const id of unlink) changes.push(`Unlink guardian ${byId.get(id)?.name ?? "unknown"}`);
    }

    if (matchedByName && changes.length) changes.unshift("Matched by name");
    const kind = !existing ? "new" : changes.length ? "update" : "same";
    items.push({ line, rider: name, kind, changes: existing ? changes : [`New rider`, ...changes], error: null });
    if (kind !== "same") {
      actions.push({
        line, riderId: existing?.id ?? null, first, last, am: existing ? amChange : am, pm: existing ? pmChange : pm,
        guardians: picks.length ? picks : null, unlink
      });
    }
  });

  return { items, actions, newGuardians, missing };
}

function tokenFor(p: Plan): string {
  return createHash("sha256").update(JSON.stringify([p.items, p.actions, p.newGuardians])).digest("hex").slice(0, 32);
}

function counts(p: Plan) {
  const n = (k: RosterImportItem["kind"]) => p.items.filter((i) => i.kind === k).length;
  return { new: n("new"), update: n("update"), same: n("same"), skip: n("skip"), error: n("error"), newGuardians: p.newGuardians.length };
}

// ---------- Routes ----------

export const dataImportRoutes = Router();
// Roster files are bigger than the app's usual 32 kB request limit.
dataImportRoutes.use(express.json({ limit: "2mb" }));

dataImportRoutes.post("/preview", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const input = rosterImportInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "That file couldn't be read. Save it as CSV and try again." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = await plan(client, input.data);
    await client.query("COMMIT");
    response.json(rosterImportPreviewSchema.parse({
      items: p.items, counts: counts(p), missingColumns: p.missing, token: tokenFor(p)
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
});

dataImportRoutes.post("/apply", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const input = rosterImportInputSchema.safeParse(request.body);
  if (!input.success || !input.data.token) {
    response.status(400).json({ error: "Preview the file first, then apply it." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One import at a time, and riders/guardians can't shift under us mid-import.
    await client.query("SELECT pg_advisory_xact_lock(472910)");
    await client.query("LOCK TABLE riders, guardians, rider_guardian_links, rider_stop_assignments IN SHARE ROW EXCLUSIVE MODE");
    const p = await plan(client, input.data);
    if (p.missing.length || tokenFor(p) !== input.data.token) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "The roster changed since you previewed this file. Preview it again before applying." });
      return;
    }

    const log = (table: string, rowId: string, column: string, oldValue: string | null, newValue: string | null) =>
      client.query(
        `INSERT INTO data_edits (member_id, member_name, table_name, row_id, column_name, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [member.id, member.display_name, table, rowId, column, oldValue, newValue]
      );

    // New guardians first, so riders can link to them.
    const newIds: string[] = [];
    for (const g of p.newGuardians) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO guardians (name, email, phone) VALUES ($1, $2, $3) RETURNING id`, [g.name, g.email, g.phone]
      );
      newIds.push(row.rows[0]!.id);
      await log("guardians", row.rows[0]!.id, "CSV import", null, `Added ${g.name}`);
    }

    let created = 0;
    let updated = 0;
    for (const a of p.actions) {
      let riderId = a.riderId;
      if (!riderId) {
        riderId = (await client.query<{ id: string }>(
          `INSERT INTO riders (given_name, family_name) VALUES ($1, $2) RETURNING id`, [a.first, a.last]
        )).rows[0]!.id;
        created += 1;
        await log("riders", riderId, "CSV import", null, `Added ${a.first} ${a.last}`);
      } else {
        await client.query(`UPDATE riders SET given_name = $2, family_name = $3 WHERE id = $1`, [riderId, a.first, a.last]);
        updated += 1;
        await log("riders", riderId, "CSV import", null, `Line ${a.line} applied`);
      }
      for (const [direction, stop] of [["AM", a.am], ["PM", a.pm]] as const) {
        if (stop === undefined) continue;
        await client.query(`DELETE FROM rider_stop_assignments WHERE rider_id = $1 AND direction = $2`, [riderId, direction]);
        if (stop) {
          await client.query(
            `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, $2, $3, $4)`,
            [riderId, direction, stop.routeId, stop.stopId]
          );
        }
      }
      if (a.guardians) {
        for (const pick of a.guardians) {
          const id = pick.kind === "new" ? newIds[pick.ref]! : pick.id;
          if (pick.kind === "existing" && Object.keys(pick.update).length) {
            await client.query(
              `UPDATE guardians SET name = COALESCE($2, name), email = COALESCE($3, email), phone = COALESCE($4, phone)
                WHERE id = $1`,
              [id, pick.update.name ?? null, pick.update.email ?? null, pick.update.phone ?? null]
            );
          }
          await client.query(
            `INSERT INTO rider_guardian_links (rider_id, guardian_id, source) VALUES ($1, $2, 'manual')
             ON CONFLICT (rider_id, guardian_id) DO NOTHING`,
            [riderId, id]
          );
        }
        if (a.unlink.length) {
          await client.query(
            `DELETE FROM rider_guardian_links WHERE rider_id = $1 AND guardian_id = ANY($2::uuid[])`,
            [riderId, a.unlink]
          );
        }
      }
    }
    await syncPlannedTripRiders(client);
    await client.query("COMMIT");
    response.json(rosterImportResultSchema.parse({
      applied: p.actions.length, created, updated, newGuardians: newIds.length
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
});
