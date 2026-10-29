import { Router, type Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  dataEditResponseSchema, dataEditSchema, dataStopOptionsResponseSchema, dataTableKeySchema,
  dataTableResponseSchema, dataTablesResponseSchema, driverInputSchema, phoneSchema,
  type DataCell, type DataColumn, type DataRow, type DataTableKey
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { syncPlannedTripRiders } from "../families/access.js";
import { emailTakenMessage, guardianEmailOwner } from "../families/contacts.js";
import { generateAndStoreRouteGeometry } from "../routes/geometry.js";

// Data mode: every table the office manages, as a plain grid.
//
// Each table is one entry below: its label, its columns, and one SQL query that
// returns an "id" column plus one column per grid column, already joined into
// plain text. Columns with an "edit" kind can be changed from the grid.
// Hidden helper columns start with "_" (never shown) or end in "Ref" (dropdown values).
//
// Every stored field is editable here. Read-only columns are counts and lists pulled
// from other tables (a rider's guardians, a route's stop count), plus staff roles,
// which are changed on the Members page. Drivers can be added here too.
// Route and stop edits change future trips only: each trip keeps its own copy of its stops.

type Table = { label: string; columns: DataColumn[]; sql: string; countSql: string };

const ROW_LIMIT = 2000;
const col = (key: string, label: string, edit: DataColumn["edit"] = null, options?: string[]): DataColumn =>
  options ? { key, label, edit, options } : { key, label, edit };
const ACTIVE_RETIRED = ["Active", "Retired"];

const TABLES: Record<DataTableKey, Table> = {
  riders: {
    label: "Riders",
    columns: [
      col("first", "First", "text"), col("last", "Last", "text"),
      col("amRoute", "AM route", "stop-AM"), col("amStop", "AM stop", "stop-AM"),
      col("pmRoute", "PM route", "stop-PM"), col("pmStop", "PM stop", "stop-PM"),
      col("guardians", "Guardians"),
      col("careNotes", "Care notes", "text"), col("emergencyName", "Emergency contact", "text"),
      col("emergencyPhone", "Emergency phone", "text"), col("source", "Source")
    ],
    sql: `SELECT r.id, r.given_name AS first, r.family_name AS last,
                 amr.name AS "amRoute", ams.label AS "amStop",
                 pmr.name AS "pmRoute", pms.label AS "pmStop",
                 CASE WHEN am.rider_id IS NULL THEN '' ELSE am.route_id || ':' || am.route_stop_id END AS "amRef",
                 CASE WHEN pm.rider_id IS NULL THEN '' ELSE pm.route_id || ':' || pm.route_stop_id END AS "pmRef",
                 (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM rider_guardian_links l
                    JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id) AS guardians,
                 r.care_notes AS "careNotes", r.emergency_name AS "emergencyName", r.emergency_phone AS "emergencyPhone",
                 CASE WHEN r.import_dataset IS NULL THEN 'Added in app' ELSE 'Imported' END AS source,
                 NULL::text AS "_locked"
            FROM riders r
            LEFT JOIN rider_stop_assignments am ON am.rider_id = r.id AND am.direction = 'AM'
            LEFT JOIN routes amr ON amr.id = am.route_id
            LEFT JOIN route_stops ams ON ams.id = am.route_stop_id
            LEFT JOIN rider_stop_assignments pm ON pm.rider_id = r.id AND pm.direction = 'PM'
            LEFT JOIN routes pmr ON pmr.id = pm.route_id
            LEFT JOIN route_stops pms ON pms.id = pm.route_stop_id
           ORDER BY r.family_name, r.given_name, r.id`,
    countSql: "SELECT count(*)::int AS n FROM riders"
  },
  guardians: {
    label: "Guardians",
    columns: [
      col("name", "Name", "text"), col("phone", "Phone", "phone"), col("email", "Email", "email"),
      col("access", "App access"), col("riders", "Riders")
    ],
    sql: `SELECT g.id, g.name, g.phone, g.email,
                 CASE WHEN g.member_id IS NULL THEN 'No login'
                      WHEN m.activated_at IS NOT NULL AND m.suspended_at IS NULL THEN 'Active'
                      ELSE 'Invited' END AS access,
                 (SELECT string_agg(r.given_name || ' ' || r.family_name, ', ' ORDER BY r.family_name, r.given_name)
                    FROM rider_guardian_links l JOIN riders r ON r.id = l.rider_id
                   WHERE l.guardian_id = g.id) AS riders,
                 NULL::text AS "_locked"
            FROM guardians g LEFT JOIN members m ON m.id = g.member_id
           ORDER BY g.name, g.id`,
    countSql: "SELECT count(*)::int AS n FROM guardians"
  },
  drivers: {
    label: "Drivers",
    columns: [
      col("name", "Driver", "text"), col("phone", "Phone", "phone"),
      col("status", "Status", "choice", ACTIVE_RETIRED), col("trips", "Trips driven")
    ],
    sql: `SELECT d.id, d.name, d.phone, CASE WHEN d.active THEN 'Active' ELSE 'Retired' END AS status,
                 (SELECT count(DISTINCT a.trip_id)::int FROM trip_driver_assignments a WHERE a.driver_id = d.id) AS trips,
                 NULL::text AS "_locked"
            FROM drivers d ORDER BY d.active DESC, d.name, d.id`,
    countSql: "SELECT count(*)::int AS n FROM drivers"
  },
  buses: {
    label: "Buses",
    columns: [col("label", "Bus", "text"), col("status", "Status", "choice", ACTIVE_RETIRED)],
    sql: `SELECT id, label, CASE WHEN active THEN 'Active' ELSE 'Retired' END AS status,
                 NULL::text AS "_locked"
            FROM buses ORDER BY active DESC, label, id`,
    countSql: "SELECT count(*)::int AS n FROM buses"
  },
  routes: {
    label: "Routes",
    columns: [
      col("name", "Route", "text"), col("family", "Family", "text"), col("period", "AM or PM", "choice", ["AM", "PM"]),
      col("stops", "Stops"), col("riders", "Riders"), col("status", "Status", "choice", ["Active", "Off"])
    ],
    sql: `SELECT r.id, r.name, f.name AS family, r.service_period AS period,
                 (SELECT count(*)::int FROM route_stops s WHERE s.route_id = r.id) AS stops,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_id = r.id) AS riders,
                 CASE WHEN r.active THEN 'Active' ELSE 'Off' END AS status,
                 NULL::text AS "_locked"
            FROM routes r JOIN route_families f ON f.id = r.route_family_id
           WHERE r.superseded_at IS NULL
           ORDER BY r.active DESC, r.name, r.id`,
    countSql: "SELECT count(*)::int AS n FROM routes WHERE superseded_at IS NULL"
  },
  stops: {
    label: "Stops",
    columns: [
      col("route", "Route"), col("order", "Order", "number"),
      col("label", "Stop", "text"), col("pin", "Map pin (lat, lng)", "pin"), col("riders", "Riders")
    ],
    sql: `SELECT s.id, r.name AS route, s.route_id AS "routeRef", s.position AS "order", s.label,
                 CASE WHEN s.latitude IS NULL OR s.longitude IS NULL THEN ''
                      ELSE trim(to_char(s.latitude, 'FM990.000000')) || ', ' || trim(to_char(s.longitude, 'FM9990.000000')) END AS pin,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_stop_id = s.id) AS riders,
                 NULL::text AS "_locked"
            FROM route_stops s JOIN routes r ON r.id = s.route_id
           WHERE r.superseded_at IS NULL
           ORDER BY r.name, s.position, s.id`,
    countSql: `SELECT count(*)::int AS n FROM route_stops s JOIN routes r ON r.id = s.route_id
                WHERE r.superseded_at IS NULL`
  },
  members: {
    label: "Staff",
    columns: [
      col("name", "Name", "text"), col("username", "Username", "text"),
      col("email", "Email", "email"), col("roles", "Roles"), col("status", "Status", "choice", ["Active", "Suspended"])
    ],
    sql: `SELECT m.id, m.display_name AS name, m.username, m.email,
                 (SELECT string_agg(initcap(mr.role), ', ' ORDER BY mr.role) FROM member_roles mr
                   WHERE mr.member_id = m.id AND mr.revoked_at IS NULL) AS roles,
                 CASE WHEN m.suspended_at IS NOT NULL THEN 'Suspended'
                      WHEN m.activated_at IS NULL THEN 'Invited' ELSE 'Active' END AS status,
                 NULL::text AS "_locked"
            FROM members m
           WHERE EXISTS (SELECT 1 FROM member_roles mr WHERE mr.member_id = m.id
                           AND mr.revoked_at IS NULL AND mr.role <> 'family')
           ORDER BY m.display_name, m.id`,
    countSql: `SELECT count(*)::int AS n FROM members m
                WHERE EXISTS (SELECT 1 FROM member_roles mr WHERE mr.member_id = m.id
                                AND mr.revoked_at IS NULL AND mr.role <> 'family')`
  }
};

type RawRow = Record<string, DataCell> & { id: string; _locked: string | null };

function toRow({ id, _locked, ...cells }: RawRow): DataRow {
  return { id, cells, locked: _locked };
}

async function readRows(client: PoolClient | typeof pool, key: DataTableKey, id?: string): Promise<DataRow[]> {
  const sql = id
    ? `SELECT * FROM (${TABLES[key].sql}) t WHERE t.id = $1`
    : `${TABLES[key].sql} LIMIT ${ROW_LIMIT}`;
  const result = await client.query<RawRow>(sql, id ? [id] : []);
  return result.rows.map(toRow);
}

export const dataRoutes = Router();

// The cards: every table with its row count.
dataRoutes.get("/", requireRole("admin"), async (_request, response) => {
  const tables = [];
  for (const key of dataTableKeySchema.options) {
    const result = await pool.query<{ n: number }>(TABLES[key].countSql);
    tables.push({ key, label: TABLES[key].label, count: result.rows[0]?.n ?? 0 });
  }
  response.json(dataTablesResponseSchema.parse({ tables }));
});

// Dropdown choices for AM and PM stops: every stop on an active, current route.
dataRoutes.get("/options/stops", requireRole("admin"), async (_request, response) => {
  const result = await pool.query<{ period: "AM" | "PM"; value: string; label: string }>(
    `SELECT r.service_period AS period, r.id || ':' || s.id AS value, r.name || ' · ' || s.label AS label
       FROM route_stops s JOIN routes r ON r.id = s.route_id
      WHERE r.active AND r.superseded_at IS NULL
      ORDER BY r.name, s.position`
  );
  response.json(dataStopOptionsResponseSchema.parse({
    AM: result.rows.filter((row) => row.period === "AM").map(({ value, label }) => ({ value, label })),
    PM: result.rows.filter((row) => row.period === "PM").map(({ value, label }) => ({ value, label }))
  }));
});

// Add a driver. Drivers have no login: just a name and an optional phone.
dataRoutes.post("/drivers", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const parsed = driverInputSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the driver's details." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: string }>(
      `INSERT INTO drivers (name, phone) VALUES ($1, $2) RETURNING id`, [parsed.data.name, parsed.data.phone]
    );
    const id = created.rows[0]!.id;
    await client.query(
      `INSERT INTO data_edits (member_id, member_name, table_name, row_id, column_name, old_value, new_value)
       VALUES ($1, $2, 'drivers', $3, 'added', NULL, $4)`,
      [member.id, member.display_name, id, parsed.data.name]
    );
    const [row] = await readRows(client, "drivers", id);
    await client.query("COMMIT");
    response.status(201).json(dataEditResponseSchema.parse({ row }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
});

// One table as a grid.
dataRoutes.get("/:table", requireRole("admin"), async (request, response) => {
  const parsed = dataTableKeySchema.safeParse(request.params.table);
  if (!parsed.success) {
    response.status(404).json({ error: "No such table." });
    return;
  }
  const table = TABLES[parsed.data];
  response.json(dataTableResponseSchema.parse({
    key: parsed.data,
    label: table.label,
    columns: table.columns,
    rows: await readRows(pool, parsed.data)
  }));
});

// ---------- Editing one cell ----------

// A refusal the person editing should see as-is.
class EditError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const name80 = z.string().trim().min(1, "Can't be blank.").max(80, "Keep it under 80 characters.");
const name120 = z.string().trim().min(1, "Can't be blank.").max(120, "Keep it under 120 characters.");
const optionalEmail = z.string().trim().toLowerCase()
  .transform((value) => value || null)
  .pipe(z.email("That isn't a valid email address.").nullable());
const optionalPhone = phoneSchema;
const optionalCare = z.string().trim().max(500, "Keep care notes under 500 characters.").transform((value) => value || null);
const optionalName120 = z.string().trim().max(120, "Keep it under 120 characters.").transform((value) => value || null);
const stopRef = z.string().regex(/^$|^[0-9a-f-]{36}:[0-9a-f-]{36}$/i, "Pick a stop from the list.");

function check<T>(schema: z.ZodType<T>, value: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EditError(400, parsed.error.issues[0]?.message ?? "That value isn't allowed.");
  return parsed.data;
}

// Compare what the grid showed with what the database has now.
function sameAsShown(current: DataCell | undefined, shown: string): boolean {
  return (current === null || current === undefined ? "" : String(current)) === shown;
}

const STALE = "Someone else changed this a moment ago. The latest value is now showing; try again.";

// refreshRoute: a route whose road line must be redrawn once the edit is saved.
type EditResult = { column: string; old: string | null; value: string | null; refreshRoute?: string };

async function editRider(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (row.locked) throw new EditError(409, row.locked);
  if (column === "first" || column === "last") {
    if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
    const next = check(name80, value);
    await client.query(`UPDATE riders SET ${column === "first" ? "given_name" : "family_name"} = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from, value: next };
  }
  if (column === "careNotes" || column === "emergencyName" || column === "emergencyPhone") {
    if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
    const next = column === "careNotes" ? check(optionalCare, value)
      : column === "emergencyName" ? check(optionalName120, value) : check(optionalPhone, value);
    const field = column === "careNotes" ? "care_notes" : column === "emergencyName" ? "emergency_name" : "emergency_phone";
    await client.query(`UPDATE riders SET ${field} = $2 WHERE id = $1`, [row.id, next]);
    return { column: column === "careNotes" ? "Care notes" : column === "emergencyName" ? "Emergency contact" : "Emergency phone", old: from || null, value: next };
  }
  const direction = column === "amRoute" || column === "amStop" ? "AM" : column === "pmRoute" || column === "pmStop" ? "PM" : null;
  if (!direction) throw new EditError(400, "That column can't be edited here.");
  const refKey = direction === "AM" ? "amRef" : "pmRef";
  if (!sameAsShown(row.cells[refKey], from)) throw new EditError(409, STALE);
  const ref = check(stopRef, value);
  const before = row.cells[direction === "AM" ? "amRoute" : "pmRoute"]
    ? `${row.cells[direction === "AM" ? "amRoute" : "pmRoute"]} · ${row.cells[direction === "AM" ? "amStop" : "pmStop"]}`
    : null;
  let after: string | null = null;
  await client.query(`DELETE FROM rider_stop_assignments WHERE rider_id = $1 AND direction = $2`, [row.id, direction]);
  if (ref) {
    const [routeId, stopId] = ref.split(":");
    const ok = await client.query<{ label: string }>(
      `SELECT r.name || ' · ' || s.label AS label FROM route_stops s JOIN routes r ON r.id = s.route_id
        WHERE s.route_id = $1 AND s.id = $2 AND r.service_period = $3
          AND r.active AND r.superseded_at IS NULL
        FOR SHARE OF s, r`,
      [routeId, stopId, direction]
    );
    if (!ok.rowCount) throw new EditError(409, `That stop isn't on an active ${direction} route anymore. Pick another.`);
    after = ok.rows[0]!.label;
    await client.query(
      `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id) VALUES ($1, $2, $3, $4)`,
      [row.id, direction, routeId, stopId]
    );
  }
  // Keep today's planned trips in step with the new assignment, as the Riders page does.
  await syncPlannedTripRiders(client);
  // The log keeps readable names ("RED AM · PU1"), not internal IDs.
  return { column: direction === "AM" ? "AM stop" : "PM stop", old: before, value: after };
}

async function editGuardian(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (!["name", "phone", "email"].includes(column)) throw new EditError(400, "That column can't be edited here.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  const next = column === "name" ? check(name120, value)
    : column === "email" ? check(optionalEmail, value)
    : check(optionalPhone, value);
  if (column === "email") {
    const owner = await guardianEmailOwner(client, next, row.id);
    if (owner) throw new EditError(409, emailTakenMessage(next!, owner));
  }
  await client.query(`UPDATE guardians SET ${column} = $2 WHERE id = $1`, [row.id, next]);
  return { column, old: from || null, value: next };
}

async function editBus(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (column !== "label" && column !== "status") throw new EditError(400, "That column can't be edited here.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  if (column === "status") {
    if (value !== "Active" && value !== "Retired") throw new EditError(400, "Pick Active or Retired.");
    if (value === "Retired") {
      const busy = await client.query(`SELECT 1 FROM trips WHERE bus_id = $1 AND status IN ('planned', 'active') LIMIT 1`, [row.id]);
      if (busy.rowCount) throw new EditError(409, "This bus has a trip that hasn't finished. Move or cancel that trip first.");
      await client.query(`UPDATE bus_devices SET revoked_at = GREATEST(now(), paired_at) WHERE bus_id = $1 AND revoked_at IS NULL`, [row.id]);
    }
    await client.query(`UPDATE buses SET active = $2 WHERE id = $1`, [row.id, value === "Active"]);
    return { column, old: from, value };
  }
  const next = check(name80, value);
  const taken = await client.query(`SELECT 1 FROM buses WHERE lower(label) = lower($1) AND id <> $2`, [next, row.id]);
  if (taken.rowCount) throw new EditError(409, `Another bus is already called "${next}".`);
  await client.query(`UPDATE buses SET label = $2 WHERE id = $1`, [row.id, next]);
  return { column, old: from, value: next };
}

// Staff: name, username, email and Active/Suspended. Username and email are the two ways
// to sign in, so one of them must stay. Roles are changed on the Members page.
async function editMember(client: PoolClient, row: DataRow, column: string, from: string, value: string, me: string): Promise<EditResult> {
  if (!["name", "username", "email", "status"].includes(column)) throw new EditError(400, "Roles (Admin, Dispatch) can't be changed here.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  if (column === "username") {
    const next = check(z.string().trim().toLowerCase()
      .transform((v) => v || null)
      .pipe(z.string().regex(/^[a-z0-9_]{3,32}$/, "3 to 32 characters: letters, numbers, underscore.").nullable()), value);
    if (!next && !row.cells.email) throw new EditError(400, "This person signs in with their username, so it can't be blank.");
    if (next) {
      const taken = await client.query(`SELECT 1 FROM members WHERE lower(username) = $1 AND id <> $2`, [next, row.id]);
      if (taken.rowCount) throw new EditError(409, "Another login already uses that username.");
    }
    await client.query(`UPDATE members SET username = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from || null, value: next };
  }
  if (column === "status") {
    if (value !== "Active" && value !== "Suspended") throw new EditError(400, "Pick Active or Suspended.");
    if (value === "Suspended") {
      if (row.id === me) throw new EditError(409, "You can't suspend yourself.");
      const otherAdmins = await client.query(
        `SELECT 1 FROM members m JOIN member_roles r ON r.member_id = m.id AND r.role = 'admin' AND r.revoked_at IS NULL
          WHERE m.id <> $1 AND m.suspended_at IS NULL LIMIT 1`, [row.id]);
      if (!otherAdmins.rowCount) throw new EditError(409, "Bussin needs at least one active admin.");
      await client.query(`UPDATE members SET suspended_at = now() WHERE id = $1 AND suspended_at IS NULL`, [row.id]);
    } else {
      await client.query(`UPDATE members SET suspended_at = NULL WHERE id = $1`, [row.id]);
    }
    return { column, old: from, value };
  }
  if (column === "name") {
    const next = check(name120, value);
    await client.query(`UPDATE members SET display_name = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from, value: next };
  }
  const next = check(optionalEmail, value);
  if (!next && !row.cells.username) throw new EditError(400, "This person signs in with their email, so it can't be blank.");
  if (next) {
    const taken = await client.query(`SELECT 1 FROM members WHERE email = $1 AND id <> $2`, [next, row.id]);
    if (taken.rowCount) throw new EditError(409, "Another login already uses that email.");
  }
  await client.query(`UPDATE members SET email = $2 WHERE id = $1`, [row.id, next]);
  return { column, old: from || null, value: next };
}

// Drivers: name, phone, and Active/Retired. A retired driver stays on past trips but
// can't be put on new ones. Retiring someone still assigned to a trip that hasn't
// finished is refused, so no running bus loses its driver record.
async function editDriver(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (!["name", "phone", "status"].includes(column)) throw new EditError(400, "That column can't be edited here.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  if (column === "name") {
    const next = check(name120, value);
    await client.query(`UPDATE drivers SET name = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from, value: next };
  }
  if (column === "phone") {
    const next = check(optionalPhone, value);
    await client.query(`UPDATE drivers SET phone = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from || null, value: next };
  }
  if (value !== "Active" && value !== "Retired") throw new EditError(400, "Pick Active or Retired.");
  if (value === "Retired") {
    const busy = await client.query(
      `SELECT 1 FROM trip_driver_assignments a JOIN trips t ON t.id = a.trip_id
        WHERE a.driver_id = $1 AND a.ended_at IS NULL AND t.status IN ('planned', 'active') LIMIT 1`,
      [row.id]
    );
    if (busy.rowCount) throw new EditError(409, "This driver is on a trip that hasn't finished. Swap them off it first.");
  }
  await client.query(`UPDATE drivers SET active = $2 WHERE id = $1`, [row.id, value === "Active"]);
  return { column, old: from, value };
}

// Routes: name, family, AM/PM and Active/Off. A family edit renames the family for all
// of its routes. AM/PM can only change while no riders or trips use the route.
async function editRoute(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (!["name", "family", "period", "status"].includes(column)) throw new EditError(400, "That column is a count. Change the stops or riders instead.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  if (column === "name") {
    const next = check(name120, value);
    await client.query(`UPDATE routes SET name = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from, value: next };
  }
  if (column === "family") {
    const next = check(name80, value);
    const taken = await client.query(
      `SELECT 1 FROM route_families WHERE lower(trim(name)) = lower(trim($1))
          AND id <> (SELECT route_family_id FROM routes WHERE id = $2)`, [next, row.id]);
    if (taken.rowCount) throw new EditError(409, `Another family is already called "${next}".`);
    await client.query(`UPDATE route_families SET name = $2 WHERE id = (SELECT route_family_id FROM routes WHERE id = $1)`, [row.id, next]);
    return { column, old: from, value: next };
  }
  if (column === "period") {
    if (value !== "AM" && value !== "PM") throw new EditError(400, "Pick AM or PM.");
    const used = await client.query(
      `SELECT EXISTS (SELECT 1 FROM rider_stop_assignments WHERE route_id = $1) AS riders,
              EXISTS (SELECT 1 FROM trips WHERE route_id = $1) AS trips`, [row.id]);
    if (used.rows[0].riders) throw new EditError(409, "Riders use this route. Move them off it before switching AM and PM.");
    if (used.rows[0].trips) throw new EditError(409, "This route has trips. Make a new route for the other period.");
    const clash = await client.query(
      `SELECT 1 FROM routes WHERE route_family_id = (SELECT route_family_id FROM routes WHERE id = $1)
          AND service_period = $2 AND superseded_at IS NULL AND id <> $1`, [row.id, value]);
    if (clash.rowCount) throw new EditError(409, `This family already has a ${value} route.`);
    await client.query(`UPDATE routes SET service_period = $2 WHERE id = $1`, [row.id, value]);
    return { column, old: from, value };
  }
  if (value !== "Active" && value !== "Off") throw new EditError(400, "Pick Active or Off.");
  await client.query(`UPDATE routes SET active = $2 WHERE id = $1`, [row.id, value === "Active"]);
  return { column, old: from, value };
}

const pinSchema = z.string().trim()
  .regex(/^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/, "Type latitude, longitude. Example: 40.7465, -74.2610")
  .transform((v) => v.split(",").map((part) => Number(part.trim())) as [number, number])
  .refine(([lat, lng]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180, "That isn't a real place on the map.");

// Stops: name, order on the route, and map pin. Trips already made keep their own copy.
async function editStop(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (!["label", "order", "pin"].includes(column)) throw new EditError(400, "That column can't be edited here.");
  if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
  const routeId = String(row.cells.routeRef);
  if (column === "label") {
    const next = check(name120, value);
    await client.query(`UPDATE route_stops SET label = $2 WHERE id = $1`, [row.id, next]);
    return { column: "stop", old: from, value: next };
  }
  if (column === "pin") {
    const [lat, lng] = check(pinSchema, value);
    await client.query(`UPDATE route_stops SET latitude = $2, longitude = $3 WHERE id = $1`, [row.id, lat, lng]);
    return { column: "map pin", old: from || null, value: `${lat}, ${lng}`, refreshRoute: routeId };
  }
  const stops = await client.query<{ id: string }>(
    `SELECT id FROM route_stops WHERE route_id = $1 ORDER BY position FOR UPDATE`, [routeId]);
  const target = check(z.string().trim().regex(/^\d+$/, "Type a whole number.").transform(Number)
    .refine((n) => n >= 1 && n <= stops.rows.length, `Pick 1 to ${stops.rows.length}.`), value);
  const order = stops.rows.map((stop) => stop.id).filter((id) => id !== row.id);
  order.splice(target - 1, 0, row.id);
  // Park every stop out of the way first so the unique (route, position) rule never trips.
  await client.query(`UPDATE route_stops SET position = position + 10000 WHERE route_id = $1`, [routeId]);
  for (const [index, id] of order.entries()) {
    await client.query(`UPDATE route_stops SET position = $2 WHERE id = $1`, [id, index + 1]);
  }
  return { column, old: from, value: String(target), refreshRoute: routeId };
}

type Editor = (client: PoolClient, row: DataRow, column: string, from: string, value: string, me: string) => Promise<EditResult>;
const EDITORS: Record<DataTableKey, Editor> = {
  drivers: editDriver,
  riders: editRider,
  guardians: editGuardian,
  buses: editBus,
  routes: editRoute,
  stops: editStop,
  members: editMember
};

const LOCK_TABLE: Record<DataTableKey, string> = {
  riders: "riders", guardians: "guardians", drivers: "drivers", buses: "buses",
  routes: "routes", stops: "route_stops", members: "members"
};

function refuse(response: Response, status: number, error: string, row?: DataRow) {
  response.status(status).json(row ? { error, row } : { error });
}

// Change one cell. Answers with the fresh row, or a plain-language reason it was refused
// (plus the fresh row when the data changed underneath, so the grid can show the latest).
dataRoutes.patch("/:table/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const table = dataTableKeySchema.safeParse(request.params.table);
  const id = z.uuid().safeParse(request.params.id);
  const edit = dataEditSchema.safeParse(request.body);
  if (!table.success || !id.success || !edit.success) {
    refuse(response, 400, "That edit couldn't be read. Reload the page and try again.");
    return;
  }
  const editor = EDITORS[table.data];
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockTable = LOCK_TABLE[table.data]!;
    const exists = await client.query(`SELECT 1 FROM ${lockTable} WHERE id = $1 FOR UPDATE`, [id.data]);
    if (!exists.rowCount) {
      await client.query("ROLLBACK");
      refuse(response, 404, "That row was deleted by someone else. Reload the table.");
      return;
    }
    const [before] = await readRows(client, table.data, id.data);
    let result: EditResult;
    try {
      result = await editor(client, before!, edit.data.column, edit.data.from, edit.data.value, member.id);
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof EditError) {
        refuse(response, error.status, error.message, error.status === 409 ? before : undefined);
        return;
      }
      throw error;
    }
    await client.query(
      `INSERT INTO data_edits (member_id, member_name, table_name, row_id, column_name, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [member.id, member.display_name, table.data, id.data, result.column, result.old, result.value]
    );
    const [after] = await readRows(client, table.data, id.data);
    await client.query("COMMIT");
    if (result.refreshRoute) {
      const routeId = result.refreshRoute;
      void generateAndStoreRouteGeometry(routeId).catch((error) => console.error(`Could not refresh geometry for route ${routeId}`, error));
    }
    response.json(dataEditResponseSchema.parse({ row: after }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
