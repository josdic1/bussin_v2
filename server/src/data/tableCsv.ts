import { createHash } from "node:crypto";
import express, { Router, type Response } from "express";
import type { PoolClient } from "pg";
import {
  formatPhone, suggestUsername, rosterImportInputSchema, rosterImportPreviewSchema, rosterImportResultSchema,
  type RosterImportInput, type RosterImportItem
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { hashPassword } from "../auth/sessions.js";
import type { SignedInMember } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import { cell } from "../families/exportCsv.js";
import { createRoute, refreshRouteGeometry, RouteSaveError, updateRoute } from "../routes/save.js";

// CSV download and upload for buses, drivers, staff, and routes with their stops.
// (Riders and guardians have their own, older import in import.ts; same rules.)
//
// Every table works the same way:
//   GET  /api/data/csv/:table            download the table as CSV
//   POST /api/data/csv/:table/preview    plan every change from an uploaded file; writes nothing
//   POST /api/data/csv/:table/apply      plan again, refuse if it differs from the preview, write it
//                                        all in one transaction (every good row lands, or nothing)
//
// Shared rules:
//   - The ID column matches an existing row. With no ID, rows match by name. Otherwise it's new.
//   - Rows not in the file are left alone. Nothing is ever deleted (except stops left out of a route).
//   - A blank column means "no value"; a missing column means "leave it as it is".
//   - Rows with a problem are listed with the reason and skipped; the rest can still be applied.

type Item = RosterImportItem;
type Applier = (client: PoolClient, member: SignedInMember) => Promise<{ created: number; updated: number; routes: string[] }>;
type Plan = { items: Item[]; missing: string[]; actions: unknown[]; apply: Applier };
type Table = {
  file: string;
  headers: Record<string, string[]>; // field -> accepted header names (first one is what we write)
  required: string[];
  download: (client: PoolClient) => Promise<(string | null)[][]>;
  plan: (client: PoolClient, rows: Row[], has: (field: string) => boolean, me: string) => Promise<Omit<Plan, "missing">>;
};
type Row = { line: number; get: (field: string) => string; blank: boolean };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const clean = (s: string | undefined) => (s ?? "").replace(/^'(?=[=+\-@])/, "").trim();
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const change = (label: string, from: string | null | undefined, to: string | null | undefined) =>
  `${label}: ${from || "(blank)"} → ${to || "(blank)"}`;

async function log(client: PoolClient, member: SignedInMember, table: string, rowId: string, text: string) {
  await client.query(
    `INSERT INTO data_edits (member_id, member_name, table_name, row_id, column_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, 'CSV import', NULL, $5)`,
    [member.id, member.display_name, table, rowId, text]
  );
}

/** Active/Retired style column. Blank keeps the current value (new rows: the first option). */
function readStatus(raw: string, options: [string, string]): string | null | Error {
  if (!raw) return null;
  const hit = options.find((option) => norm(option) === norm(raw));
  return hit ?? new Error(`Status must be ${options[0]} or ${options[1]}.`);
}

// ---------------------------------------------------------------------------
// Buses: Bus ID | Bus | Status
// ---------------------------------------------------------------------------

const buses: Table = {
  file: "buses",
  headers: { id: ["Bus ID"], label: ["Bus", "Bus name", "Label"], status: ["Status"] },
  required: ["label"],
  async download(client) {
    const result = await client.query<{ id: string; label: string; active: boolean }>(
      `SELECT id, label, active FROM buses ORDER BY active DESC, label, id`);
    return result.rows.map((b) => [b.id, b.label, b.active ? "Active" : "Retired"]);
  },
  async plan(client, rows, has) {
    const all = (await client.query<{ id: string; label: string; active: boolean; busy: boolean }>(
      `SELECT b.id, b.label, b.active,
              EXISTS (SELECT 1 FROM trips t WHERE t.bus_id = b.id AND t.status IN ('planned', 'active')) AS busy
         FROM buses b`)).rows;
    const items: Item[] = [];
    const actions: { line: number; id: string | null; label: string; active: boolean }[] = [];
    const seen = new Set<string>();
    const labels = new Set<string>();
    for (const row of rows) {
      const label = row.get("label");
      const name = label || `Line ${row.line}`;
      const fail = (error: string) => items.push({ line: row.line, rider: name, kind: "error", changes: [], error });
      const id = row.get("id");
      let existing = id ? all.find((b) => b.id === id) : all.find((b) => norm(b.label) === norm(label));
      if (id && !existing) { fail("No bus has this Bus ID. Leave it blank to add a new bus."); continue; }
      if (!label) { fail("Bus name is required."); continue; }
      if (label.length > 80) { fail("Keep the bus name under 80 characters."); continue; }
      if (labels.has(norm(label))) { fail(`"${label}" appears twice in the file.`); continue; }
      labels.add(norm(label));
      if (existing) {
        if (seen.has(existing.id)) { fail("This bus appears twice in the file."); continue; }
        seen.add(existing.id);
      }
      const clash = all.find((b) => b.id !== existing?.id && norm(b.label) === norm(label));
      if (clash) { fail(`Another bus is already called "${clash.label}".`); continue; }
      const status = has("status") ? readStatus(row.get("status"), ["Active", "Retired"]) : null;
      if (status instanceof Error) { fail(status.message); continue; }
      const active = status === null ? existing?.active ?? true : status === "Active";
      if (existing && existing.active && !active && existing.busy) {
        fail("This bus has a trip that hasn't finished. Move or cancel that trip first."); continue;
      }
      const changes: string[] = [];
      if (existing && existing.label !== label) changes.push(change("Bus", existing.label, label));
      if (existing && existing.active !== active) changes.push(change("Status", existing.active ? "Active" : "Retired", active ? "Active" : "Retired"));
      const kind = !existing ? "new" : changes.length ? "update" : "same";
      items.push({ line: row.line, rider: label, kind, changes: existing ? changes : ["New bus", ...(active ? [] : ["Retired"])], error: null });
      if (kind !== "same") actions.push({ line: row.line, id: existing?.id ?? null, label, active });
    }
    return {
      items, actions,
      async apply(client, member) {
        let created = 0; let updated = 0;
        for (const a of actions) {
          if (!a.id) {
            const row = await client.query<{ id: string }>(`INSERT INTO buses (label, active) VALUES ($1, $2) RETURNING id`, [a.label, a.active]);
            await log(client, member, "buses", row.rows[0]!.id, `Added ${a.label}`);
            created += 1;
          } else {
            await client.query(`UPDATE buses SET label = $2, active = $3 WHERE id = $1`, [a.id, a.label, a.active]);
            if (!a.active) await client.query(`UPDATE bus_devices SET revoked_at = GREATEST(now(), paired_at) WHERE bus_id = $1 AND revoked_at IS NULL`, [a.id]);
            await log(client, member, "buses", a.id, `Line ${a.line} applied`);
            updated += 1;
          }
        }
        return { created, updated, routes: [] };
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Drivers: Driver ID | Driver | Phone | Status
// ---------------------------------------------------------------------------

const drivers: Table = {
  file: "drivers",
  headers: { id: ["Driver ID"], name: ["Driver", "Name", "Driver name"], phone: ["Phone"], status: ["Status"] },
  required: ["name"],
  async download(client) {
    const result = await client.query<{ id: string; name: string; phone: string | null; active: boolean }>(
      `SELECT id, name, phone, active FROM drivers ORDER BY active DESC, name, id`);
    return result.rows.map((d) => [d.id, d.name, d.phone, d.active ? "Active" : "Retired"]);
  },
  async plan(client, rows, has) {
    const all = (await client.query<{ id: string; name: string; phone: string | null; active: boolean; busy: boolean }>(
      `SELECT d.id, d.name, d.phone, d.active,
              EXISTS (SELECT 1 FROM trip_driver_assignments a JOIN trips t ON t.id = a.trip_id
                       WHERE a.driver_id = d.id AND a.ended_at IS NULL AND t.status IN ('planned', 'active')) AS busy
         FROM drivers d`)).rows;
    const items: Item[] = [];
    const actions: { line: number; id: string | null; name: string; phone: string | null; active: boolean }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const name = row.get("name");
      const fail = (error: string) => items.push({ line: row.line, rider: name || `Line ${row.line}`, kind: "error", changes: [], error });
      const id = row.get("id");
      let existing = id ? all.find((d) => d.id === id) : undefined;
      if (id && !existing) { fail("No driver has this Driver ID. Leave it blank to add a new driver."); continue; }
      if (!name) { fail("Driver name is required."); continue; }
      if (name.length > 120) { fail("Keep the name under 120 characters."); continue; }
      if (!existing) {
        const same = all.filter((d) => norm(d.name) === norm(name));
        if (same.length > 1) { fail(`There are ${same.length} drivers named ${name}. Add the Driver ID from Download CSV.`); continue; }
        existing = same[0];
      }
      if (existing) {
        if (seen.has(existing.id)) { fail("This driver appears twice in the file."); continue; }
        seen.add(existing.id);
      }
      const formatted = formatPhone(row.get("phone"));
      if (!formatted.ok) { fail(`Phone "${row.get("phone")}": ${formatted.error}`); continue; }
      const phone = has("phone") ? formatted.value : existing?.phone ?? null;
      const status = has("status") ? readStatus(row.get("status"), ["Active", "Retired"]) : null;
      if (status instanceof Error) { fail(status.message); continue; }
      const active = status === null ? existing?.active ?? true : status === "Active";
      if (existing && existing.active && !active && existing.busy) {
        fail("This driver is on a trip that hasn't finished. Swap them off it first."); continue;
      }
      const changes: string[] = [];
      if (existing && existing.name !== name) changes.push(change("Driver", existing.name, name));
      if (existing && (existing.phone ?? null) !== phone) changes.push(change("Phone", existing.phone, phone));
      if (existing && existing.active !== active) changes.push(change("Status", existing.active ? "Active" : "Retired", active ? "Active" : "Retired"));
      const kind = !existing ? "new" : changes.length ? "update" : "same";
      items.push({ line: row.line, rider: name, kind, changes: existing ? changes : ["New driver"], error: null });
      if (kind !== "same") actions.push({ line: row.line, id: existing?.id ?? null, name, phone, active });
    }
    return {
      items, actions,
      async apply(client, member) {
        let created = 0; let updated = 0;
        for (const a of actions) {
          if (!a.id) {
            const row = await client.query<{ id: string }>(
              `INSERT INTO drivers (name, phone, active) VALUES ($1, $2, $3) RETURNING id`, [a.name, a.phone, a.active]);
            await log(client, member, "drivers", row.rows[0]!.id, `Added ${a.name}`);
            created += 1;
          } else {
            await client.query(`UPDATE drivers SET name = $2, phone = $3, active = $4 WHERE id = $1`, [a.id, a.name, a.phone, a.active]);
            await log(client, member, "drivers", a.id, `Line ${a.line} applied`);
            updated += 1;
          }
        }
        return { created, updated, routes: [] };
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Staff: Staff ID | Name | Username | Email | Roles | Status | Temporary password
// Roles are read-only here (Members page). New logins are Staff and must change
// the temporary password the first time they sign in, same as the Members page.
// ---------------------------------------------------------------------------

const staff: Table = {
  file: "staff",
  headers: {
    id: ["Staff ID"], name: ["Name"], username: ["Username"], email: ["Email"],
    roles: ["Roles"], status: ["Status"], password: ["Temporary password"]
  },
  required: ["name"],
  async download(client) {
    const result = await client.query<{ id: string; name: string; username: string | null; email: string | null; roles: string; status: string }>(
      `SELECT m.id, m.display_name AS name, m.username, m.email,
              (SELECT string_agg(initcap(r.role), ', ' ORDER BY r.role) FROM member_roles r
                WHERE r.member_id = m.id AND r.revoked_at IS NULL) AS roles,
              CASE WHEN m.suspended_at IS NOT NULL THEN 'Suspended' ELSE 'Active' END AS status
         FROM members m
        WHERE EXISTS (SELECT 1 FROM member_roles r WHERE r.member_id = m.id AND r.revoked_at IS NULL AND r.role <> 'family')
        ORDER BY m.display_name, m.id`);
    return result.rows.map((m) => [m.id, m.name, m.username, m.email, m.roles, m.status, ""]);
  },
  async plan(client, rows, has, me) {
    const all = (await client.query<{ id: string; name: string; username: string | null; email: string | null; suspended: boolean; admin: boolean; staffish: boolean }>(
      `SELECT m.id, m.display_name AS name, m.username, m.email, m.suspended_at IS NOT NULL AS suspended,
              EXISTS (SELECT 1 FROM member_roles r WHERE r.member_id = m.id AND r.revoked_at IS NULL AND r.role = 'admin') AS admin,
              EXISTS (SELECT 1 FROM member_roles r WHERE r.member_id = m.id AND r.revoked_at IS NULL AND r.role <> 'family') AS staffish
         FROM members m`)).rows;
    const items: Item[] = [];
    type Action = { line: number; id: string | null; name: string; username: string | null; email: string | null; suspended: boolean; password: string | null };
    const actions: Action[] = [];
    const seen = new Set<string>();
    const usernames = new Set<string>();
    const emails = new Set<string>();
    const suspendedAdmins = new Set<string>();
    for (const row of rows) {
      const name = row.get("name");
      const fail = (error: string) => items.push({ line: row.line, rider: name || `Line ${row.line}`, kind: "error", changes: [], error });
      const id = row.get("id");
      const rawUsername = row.get("username").toLowerCase();
      const rawEmail = row.get("email").toLowerCase();
      let existing = id ? all.find((m) => m.id === id && m.staffish) : undefined;
      if (id && !existing) { fail("No staff login has this Staff ID. Leave it blank to add a new login."); continue; }
      if (!existing && rawUsername) existing = all.find((m) => m.staffish && m.username === rawUsername);
      if (!existing && rawEmail) existing = all.find((m) => m.staffish && m.email === rawEmail);
      if (!name) { fail("Name is required."); continue; }
      if (name.length > 120) { fail("Keep the name under 120 characters."); continue; }
      if (existing) {
        if (seen.has(existing.id)) { fail("This person appears twice in the file."); continue; }
        seen.add(existing.id);
      }
      // New logins with no username get one: first name + last initial (emilyg), never a duplicate.
      const madeUp = !existing && !rawUsername;
      const username = madeUp
        ? suggestUsername(name, (candidate) => usernames.has(candidate) || all.some((m) => m.username === candidate))
        : has("username") ? rawUsername || null : existing?.username ?? null;
      const email = has("email") ? rawEmail || null : existing?.email ?? null;
      if (username && !/^[a-z0-9_]{3,32}$/.test(username)) { fail("Username: 3 to 32 characters, letters, numbers, underscore."); continue; }
      if (email && !validEmail(email)) { fail(`"${email}" isn't a valid email.`); continue; }
      if (!username && !email) { fail("Needs a username or an email to sign in with."); continue; }
      if (username && (usernames.has(username) || all.some((m) => m.id !== existing?.id && m.username === username))) {
        fail(`The username "${username}" is already taken.`); continue;
      }
      if (email && (emails.has(email) || all.some((m) => m.id !== existing?.id && m.email === email))) {
        fail(`The email ${email} is already used by another login.`); continue;
      }
      const password = row.get("password");
      if (!existing && password.length < 12) { fail("New logins need a temporary password of 12 characters or more."); continue; }
      const status = has("status") ? readStatus(row.get("status"), ["Active", "Suspended"]) : null;
      if (status instanceof Error) { fail(status.message); continue; }
      const suspended = status === null ? existing?.suspended ?? false : status === "Suspended";
      if (existing && suspended && !existing.suspended) {
        if (existing.id === me) { fail("You can't suspend yourself."); continue; }
        if (existing.admin) {
          const left = all.filter((m) => m.admin && !m.suspended && m.id !== existing!.id && !suspendedAdmins.has(m.id));
          if (!left.length) { fail("Bussin needs at least one active admin."); continue; }
          suspendedAdmins.add(existing.id);
        }
      }
      if (username) usernames.add(username);
      if (email) emails.add(email);
      const changes: string[] = [];
      if (existing) {
        if (existing.name !== name) changes.push(change("Name", existing.name, name));
        if (existing.username !== username) changes.push(change("Username", existing.username, username));
        if (existing.email !== email) changes.push(change("Email", existing.email, email));
        if (existing.suspended !== suspended) changes.push(change("Status", existing.suspended ? "Suspended" : "Active", suspended ? "Suspended" : "Active"));
      }
      const kind = !existing ? "new" : changes.length ? "update" : "same";
      items.push({ line: row.line, rider: name, kind, changes: existing ? changes : [`New staff login, username ${username}${madeUp ? " (made from the name)" : ""}`, "Must change password on first sign-in"], error: null });
      if (kind !== "same") actions.push({ line: row.line, id: existing?.id ?? null, name, username, email, suspended, password: existing ? null : password });
    }
    return {
      items,
      // The token never includes passwords.
      actions: actions.map((a) => ({ ...a, password: a.password ? createHash("sha256").update(a.password).digest("hex") : null })),
      async apply(client, member) {
        let created = 0; let updated = 0;
        for (const a of actions) {
          if (!a.id) {
            const hash = await hashPassword(a.password!);
            const row = await client.query<{ id: string }>(
              `INSERT INTO members (display_name, username, email, password_hash, activated_at, password_change_required, suspended_at)
               VALUES ($1, $2, $3, $4, now(), true, CASE WHEN $5 THEN now() END) RETURNING id`,
              [a.name, a.username, a.email, hash, a.suspended]);
            await client.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')`, [row.rows[0]!.id]);
            await log(client, member, "members", row.rows[0]!.id, `Added ${a.name}`);
            created += 1;
          } else {
            await client.query(
              `UPDATE members SET display_name = $2, username = $3, email = $4,
                      suspended_at = CASE WHEN $5 THEN COALESCE(suspended_at, now()) END
                WHERE id = $1`,
              [a.id, a.name, a.username, a.email, a.suspended]);
            await log(client, member, "members", a.id, `Line ${a.line} applied`);
            updated += 1;
          }
        }
        return { created, updated, routes: [] };
      }
    };
  }
};

// ---------------------------------------------------------------------------
// Routes and stops, one row per stop:
//   Route ID | Route | Family | AM/PM | Status | Stop ID | Stop # | Stop | Latitude | Longitude
// Rows with the same Route ID (or, without IDs, the same Route name) make one route.
// The stops listed become the route's stops, in Stop # order. Saved through the same
// code as the Routes page, so a route that already has trips gets a new revision.
// ---------------------------------------------------------------------------

type RouteNow = {
  id: string; name: string; family: string; period: "AM" | "PM"; active: boolean; used: boolean;
  stops: { id: string; position: number; label: string; latitude: number; longitude: number; riders: number }[];
  riderPeriods: string[];
};

const routes: Table = {
  file: "routes",
  headers: {
    routeId: ["Route ID"], route: ["Route", "Route name"], family: ["Family", "Route family"],
    period: ["AM/PM", "AM or PM", "Period"], status: ["Status"],
    stopId: ["Stop ID"], order: ["Stop #", "Stop number", "Order"], stop: ["Stop", "Stop name"],
    latitude: ["Latitude", "Lat"], longitude: ["Longitude", "Lng", "Long"]
  },
  required: ["route", "family", "period", "stop", "latitude", "longitude"],
  async download(client) {
    const result = await client.query<{ routeId: string; route: string; family: string; period: string; active: boolean;
      stopId: string | null; position: number | null; stop: string | null; latitude: string | null; longitude: string | null }>(
      `SELECT r.id AS "routeId", r.name AS route, f.name AS family, r.service_period AS period, r.active,
              s.id AS "stopId", s.position, s.label AS stop, s.latitude::text AS latitude, s.longitude::text AS longitude
         FROM routes r JOIN route_families f ON f.id = r.route_family_id
         LEFT JOIN route_stops s ON s.route_id = r.id
        WHERE r.superseded_at IS NULL
        ORDER BY f.name, r.service_period, r.name, r.id, s.position`);
    return result.rows.map((r) => [r.routeId, r.route, r.family, r.period, r.active ? "Active" : "Off",
      r.stopId, r.position === null ? null : String(r.position), r.stop, r.latitude, r.longitude]);
  },
  async plan(client, rows, has) {
    const current = new Map<string, RouteNow>();
    const routeRows = (await client.query<{ id: string; name: string; family: string; period: "AM" | "PM"; active: boolean; used: boolean; riderPeriods: string[] }>(
      `SELECT r.id, r.name, f.name AS family, r.service_period AS period, r.active,
              EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.id) AS used,
              ARRAY(SELECT DISTINCT a.direction FROM rider_stop_assignments a WHERE a.route_id = r.id) AS "riderPeriods"
         FROM routes r JOIN route_families f ON f.id = r.route_family_id WHERE r.superseded_at IS NULL`)).rows;
    for (const r of routeRows) current.set(r.id, { ...r, stops: [] });
    const stopRows = (await client.query<{ routeId: string; id: string; position: number; label: string; latitude: number; longitude: number; riders: number }>(
      `SELECT s.route_id AS "routeId", s.id, s.position, s.label,
              s.latitude::double precision AS latitude, s.longitude::double precision AS longitude,
              (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_stop_id = s.id) AS riders
         FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE r.superseded_at IS NULL ORDER BY s.position`)).rows;
    for (const s of stopRows) current.get(s.routeId)?.stops.push(s);

    // Group rows into routes.
    const groups = new Map<string, Row[]>();
    const items: Item[] = [];
    for (const row of rows) {
      const key = row.get("routeId") ? `id:${row.get("routeId")}` : row.get("route") ? `name:${norm(row.get("route"))}` : `line:${row.line}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    type Action = { line: number; id: string | null; name: string; familyName: string; servicePeriod: "AM" | "PM"; active: boolean;
      stops: { id?: string; label: string; latitude: number; longitude: number }[]; reshape: boolean };
    const actions: Action[] = [];
    const takenSlots = new Map<string, string>(); // family|period -> route label in this file
    const seenRoutes = new Set<string>();

    for (const group of groups.values()) {
      const first = group[0]!;
      const pick = (field: string) => {
        const values = [...new Set(group.map((r) => r.get(field)).filter(Boolean))];
        return values.length > 1 ? new Error(`Rows of this route disagree on ${field === "period" ? "AM/PM" : field}: ${values.join(" vs ")}.`) : values[0] ?? "";
      };
      const name = pick("route");
      const label = typeof name === "string" && name ? name : `Line ${first.line}`;
      const fail = (error: string) => items.push({ line: first.line, rider: label, kind: "error", changes: [], error });
      const family = pick("family"); const periodRaw = pick("period"); const statusRaw = pick("status");
      const problem = [name, family, periodRaw, statusRaw].find((v) => v instanceof Error);
      if (problem instanceof Error) { fail(problem.message); continue; }
      const routeId = first.get("routeId");
      let existing = routeId ? current.get(routeId) : undefined;
      if (routeId && !existing) {
        fail(isUuid(routeId) ? "This Route ID isn't a current route (it may have been revised). Download CSV again." : "No route has this Route ID.");
        continue;
      }
      if (!existing && name) existing = [...current.values()].find((r) => norm(r.name) === norm(name as string));
      if (!name) { fail("Route name is required."); continue; }
      if (!family) { fail("Family is required."); continue; }
      const period = (periodRaw as string).toUpperCase();
      if (period !== "AM" && period !== "PM") { fail("AM/PM must be AM or PM."); continue; }
      if ((name as string).length > 120 || (family as string).length > 80) { fail("Route names stay under 120 characters, family names under 80."); continue; }
      if (existing) {
        if (seenRoutes.has(existing.id)) { fail("This route appears twice in the file."); continue; }
        seenRoutes.add(existing.id);
      }
      const status = has("status") ? readStatus(statusRaw as string, ["Active", "Off"]) : null;
      if (status instanceof Error) { fail(status.message); continue; }
      const active = status === null ? existing?.active ?? true : status === "Active";

      // Stops, in Stop # order (file order when Stop # is blank).
      const stops: Action["stops"] = [];
      let stopProblem = "";
      const numbered = group.map((row, index) => ({ row, index, order: row.get("order") }));
      if (numbered.some((s) => s.order && !/^\d+$/.test(s.order))) stopProblem = "Stop # must be a whole number.";
      const orders = numbered.filter((s) => s.order).map((s) => Number(s.order));
      if (!stopProblem && new Set(orders).size !== orders.length) stopProblem = "Two stops have the same Stop #.";
      numbered.sort((a, b) => (a.order && b.order ? Number(a.order) - Number(b.order) : a.index - b.index));
      const usedStopIds = new Set<string>();
      for (const { row } of numbered) {
        if (stopProblem) break;
        const stopName = row.get("stop");
        const lat = Number(row.get("latitude")); const lng = Number(row.get("longitude"));
        if (!stopName) { stopProblem = `Line ${row.line}: Stop name is required.`; break; }
        if (stopName.length > 120) { stopProblem = `Line ${row.line}: keep stop names under 120 characters.`; break; }
        if (!row.get("latitude") || !row.get("longitude") || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          stopProblem = `Line ${row.line}: ${stopName} needs a real Latitude and Longitude.`; break;
        }
        const stopId = row.get("stopId");
        let match = existing && stopId ? existing.stops.find((s) => s.id === stopId) : undefined;
        if (stopId && !match) { stopProblem = `Line ${row.line}: that Stop ID isn't on this route. Leave it blank to add a stop.`; break; }
        if (!match && existing) {
          const same = existing.stops.filter((s) => norm(s.label) === norm(stopName) && !usedStopIds.has(s.id));
          match = same.length === 1 ? same[0] : undefined;
        }
        if (match) {
          if (usedStopIds.has(match.id)) { stopProblem = `Line ${row.line}: this stop is listed twice.`; break; }
          usedStopIds.add(match.id);
        }
        stops.push({ ...(match ? { id: match.id } : {}), label: stopName, latitude: lat, longitude: lng });
      }
      if (stopProblem) { fail(stopProblem); continue; }
      if (stops.length > 100) { fail("A route can have at most 100 stops."); continue; }

      // Same rules the Routes page enforces, checked up front so the preview is honest.
      const slot = `${norm(family as string)}|${period}`;
      const other = [...current.values()].find((r) => r.id !== existing?.id && `${norm(r.family)}|${r.period}` === slot);
      if (other) { fail(`${family} already has an ${period} route (${other.name}).`); continue; }
      if (takenSlots.has(slot)) { fail(`${family} ${period} is also used by ${takenSlots.get(slot)} in this file.`); continue; }
      takenSlots.set(slot, name as string);
      if (existing) {
        if (existing.riderPeriods.some((p) => p !== period)) { fail("Riders use this route. Move them off it before switching AM and PM."); continue; }
        if (existing.used && (norm(existing.family) !== norm(family as string) || existing.period !== period)) {
          fail("This route has trips, so its family and AM/PM can't change. Add a new route instead."); continue;
        }
        const removed = existing.stops.filter((s) => !usedStopIds.has(s.id) && s.riders > 0);
        if (removed.length) { fail(`Riders still use ${removed.map((s) => s.label).join(", ")}, which this file leaves out. Move them first.`); continue; }
      }

      const changes: string[] = [];
      let reshape = !existing;
      if (existing) {
        if (existing.name !== name) { changes.push(change("Route", existing.name, name as string)); reshape = true; }
        if (norm(existing.family) !== norm(family as string)) { changes.push(change("Family", existing.family, family as string)); reshape = true; }
        if (existing.period !== period) { changes.push(change("AM/PM", existing.period, period)); reshape = true; }
        if (existing.active !== active) changes.push(change("Status", existing.active ? "Active" : "Off", active ? "Active" : "Off"));
        for (const s of existing.stops) if (!usedStopIds.has(s.id)) { changes.push(`Remove stop ${s.label}`); reshape = true; }
        stops.forEach((s, index) => {
          const was = s.id ? existing!.stops.find((x) => x.id === s.id) : undefined;
          if (!was) { changes.push(`Add stop ${s.label} at #${index + 1}`); reshape = true; return; }
          if (was.label !== s.label) { changes.push(change("Stop", was.label, s.label)); reshape = true; }
          if (was.position !== index + 1) { changes.push(`Move ${s.label}: #${was.position} → #${index + 1}`); reshape = true; }
          if (Math.abs(was.latitude - s.latitude) > 1e-6 || Math.abs(was.longitude - s.longitude) > 1e-6) {
            changes.push(`Move pin for ${s.label}`); reshape = true;
          }
        });
        if (reshape && existing.used) changes.push("Saved as a new revision; past trips keep the old version");
      }
      const kind = !existing ? "new" : changes.length ? "update" : "same";
      items.push({ line: first.line, rider: name as string, kind, changes: existing ? changes : [`New ${period} route, ${stops.length} stops`], error: null });
      if (kind !== "same") {
        actions.push({ line: first.line, id: existing?.id ?? null, name: name as string, familyName: family as string,
          servicePeriod: period, active, stops, reshape });
      }
    }
    return {
      items, actions,
      async apply(client, member) {
        let created = 0; let updated = 0;
        const touched: string[] = [];
        for (const a of actions) {
          try {
            let id = a.id;
            if (!id) {
              const route = await createRoute(client, { name: a.name, familyName: a.familyName, servicePeriod: a.servicePeriod, stops: a.stops });
              id = route.id; created += 1;
              await log(client, member, "routes", id, `Added ${a.name}`);
            } else {
              if (a.reshape) id = (await updateRoute(client, id, { name: a.name, familyName: a.familyName, servicePeriod: a.servicePeriod, stops: a.stops })).id;
              updated += 1;
              await log(client, member, "routes", id, `Line ${a.line} applied`);
            }
            await client.query(`UPDATE routes SET active = $2 WHERE id = $1`, [id, a.active]);
            if (a.reshape) touched.push(id);
          } catch (error) {
            if (error instanceof RouteSaveError) throw new RouteSaveError(error.status, `${a.name} (line ${a.line}): ${error.message}`);
            throw error;
          }
        }
        return { created, updated, routes: touched };
      }
    };
  }
};

const TABLES: Record<string, Table> = { buses, drivers, staff, routes };

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function readFile(table: Table, input: RosterImportInput) {
  const index: Record<string, number> = {};
  for (const [field, names] of Object.entries(table.headers)) {
    index[field] = input.headers.findIndex((h) => names.some((n) => norm(n) === norm(clean(h))));
  }
  const missing = table.required.filter((f) => index[f]! < 0).map((f) => table.headers[f]![0]!);
  const rows: Row[] = input.rows
    .map((cells, i) => ({
      line: i + 2, // line 1 is the header row
      get: (field: string) => (index[field]! >= 0 ? clean(cells[index[field]!]) : ""),
      blank: cells.every((c) => !clean(c))
    }))
    .filter((row) => !row.blank);
  return { rows, missing, has: (field: string) => index[field]! >= 0 };
}

async function makePlan(client: PoolClient, table: Table, input: RosterImportInput, me: string): Promise<Plan> {
  const file = readFile(table, input);
  if (file.missing.length) return { items: [], missing: file.missing, actions: [], apply: async () => ({ created: 0, updated: 0, routes: [] }) };
  return { ...(await table.plan(client, file.rows, file.has, me)), missing: [] };
}

const tokenFor = (p: Plan) => createHash("sha256").update(JSON.stringify([p.items, p.actions])).digest("hex").slice(0, 32);
const counts = (p: Plan) => {
  const n = (k: Item["kind"]) => p.items.filter((i) => i.kind === k).length;
  return { new: n("new"), update: n("update"), same: n("same"), skip: n("skip"), error: n("error"), newGuardians: 0 };
};

function tableFrom(raw: unknown, response: Response): Table | null {
  const table = typeof raw === "string" ? TABLES[raw] : undefined;
  if (!table) response.status(404).json({ error: "That table can't be downloaded or uploaded here." });
  return table ?? null;
}

export const tableCsvRoutes = Router();
tableCsvRoutes.use(express.json({ limit: "2mb" }));

tableCsvRoutes.get("/:table", requireRole("admin"), async (request, response) => {
  const table = tableFrom(request.params.table, response);
  if (!table) return;
  const client = await pool.connect();
  let rows: (string | null)[][];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    rows = await table.download(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  const header = Object.values(table.headers).map((names) => names[0]!);
  const lines = [header, ...rows].map((row) => row.map(cell).join(","));
  const tenant = await readTenant();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${tenant.key}-${table.file}-${day}.csv"`);
  response.setHeader("Cache-Control", "no-store");
  // The BOM tells Excel the file is UTF-8.
  response.send(`﻿${lines.join("\r\n")}\r\n`);
});

tableCsvRoutes.post("/:table/preview", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const table = tableFrom(request.params.table, response);
  if (!table) return;
  const input = rosterImportInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "That file couldn't be read. Save it as CSV and try again." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const plan = await makePlan(client, table, input.data, member.id);
    await client.query("COMMIT");
    response.json(rosterImportPreviewSchema.parse({ items: plan.items, counts: counts(plan), missingColumns: plan.missing, token: tokenFor(plan) }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

tableCsvRoutes.post("/:table/apply", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const table = tableFrom(request.params.table, response);
  if (!table) return;
  const input = rosterImportInputSchema.safeParse(request.body);
  if (!input.success || !input.data.token) {
    response.status(400).json({ error: "Preview the file first, then apply it." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  let routesToRedraw: string[] = [];
  try {
    await client.query("BEGIN");
    // One upload at a time across every table, so two files can't interleave.
    await client.query("SELECT pg_advisory_xact_lock(472911)");
    const plan = await makePlan(client, table, input.data, member.id);
    if (plan.missing.length || tokenFor(plan) !== input.data.token) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "The data changed since you previewed this file. Preview it again before applying." });
      return;
    }
    const result = await plan.apply(client, member);
    await client.query("COMMIT");
    routesToRedraw = result.routes;
    response.json(rosterImportResultSchema.parse({ applied: plan.actions.length, created: result.created, updated: result.updated, newGuardians: 0 }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RouteSaveError) { response.status(error.status).json({ error: `Nothing was changed. ${error.message}` }); return; }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.status(409).json({ error: "Nothing was changed: a name, username or email is already taken. Preview the file again." });
      return;
    }
    throw error;
  } finally { client.release(); }
  for (const id of routesToRedraw) refreshRouteGeometry(id);
});
