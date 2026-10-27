import { Router, type Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  dataEditResponseSchema, dataEditSchema, dataStopOptionsResponseSchema, dataTableKeySchema,
  dataTableResponseSchema, dataTablesResponseSchema,
  type DataCell, type DataColumn, type DataRow, type DataTableKey
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { syncPlannedTripRiders } from "../families/access.js";

// Data mode: every table the office manages, as a plain grid.
//
// Each table is one entry below: its label, its columns, and one SQL query that
// returns an "id" column plus one column per grid column, already joined into
// plain text. Columns with an "edit" kind can be changed from the grid.
// Hidden helper columns start with "_" (never shown) or end in "Ref" (dropdown values).
//
// Editable today: rider names and AM/PM stops, guardian name/phone/email, bus label.
// Routes, stops and staff stay read-only here; they have their own pages with more rules.

type Table = { label: string; columns: DataColumn[]; sql: string; countSql: string };

const ROW_LIMIT = 2000;
const col = (key: string, label: string, edit: DataColumn["edit"] = null): DataColumn => ({ key, label, edit });

const TABLES: Record<DataTableKey, Table> = {
  riders: {
    label: "Riders",
    columns: [
      col("first", "First", "text"), col("last", "Last", "text"),
      col("amRoute", "AM route", "stop-AM"), col("amStop", "AM stop", "stop-AM"),
      col("pmRoute", "PM route", "stop-PM"), col("pmStop", "PM stop", "stop-PM"),
      col("guardians", "Guardians"), col("source", "Source")
    ],
    sql: `SELECT r.id, r.given_name AS first, r.family_name AS last,
                 amr.name AS "amRoute", ams.label AS "amStop",
                 pmr.name AS "pmRoute", pms.label AS "pmStop",
                 CASE WHEN am.rider_id IS NULL THEN '' ELSE am.route_id || ':' || am.route_stop_id END AS "amRef",
                 CASE WHEN pm.rider_id IS NULL THEN '' ELSE pm.route_id || ':' || pm.route_stop_id END AS "pmRef",
                 (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM rider_guardian_links l
                    JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id) AS guardians,
                 CASE WHEN r.import_dataset IS NULL THEN 'Added in app' ELSE 'Imported' END AS source,
                 CASE WHEN r.import_dataset IS NULL THEN NULL
                      ELSE 'Imported from a roster file. Change it in the file and reimport.' END AS "_locked"
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
  buses: {
    label: "Buses",
    columns: [col("label", "Bus", "text"), col("status", "Status")],
    sql: `SELECT id, label, CASE WHEN active THEN 'Active' ELSE 'Retired' END AS status,
                 NULL::text AS "_locked"
            FROM buses ORDER BY active DESC, label, id`,
    countSql: "SELECT count(*)::int AS n FROM buses"
  },
  routes: {
    label: "Routes",
    columns: [
      col("name", "Route"), col("period", "AM or PM"),
      col("stops", "Stops"), col("riders", "Riders"), col("status", "Status")
    ],
    sql: `SELECT r.id, r.name, r.service_period AS period,
                 (SELECT count(*)::int FROM route_stops s WHERE s.route_id = r.id) AS stops,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_id = r.id) AS riders,
                 CASE WHEN r.active THEN 'Active' ELSE 'Off' END AS status,
                 'Change routes on the Routes page.' AS "_locked"
            FROM routes r WHERE r.superseded_at IS NULL
           ORDER BY r.active DESC, r.name, r.id`,
    countSql: "SELECT count(*)::int AS n FROM routes WHERE superseded_at IS NULL"
  },
  stops: {
    label: "Stops",
    columns: [
      col("route", "Route"), col("order", "Order"),
      col("label", "Stop"), col("pinned", "On map"), col("riders", "Riders")
    ],
    sql: `SELECT s.id, r.name AS route, s.position AS "order", s.label,
                 CASE WHEN s.latitude IS NULL OR s.longitude IS NULL THEN 'No pin' ELSE 'Pinned' END AS pinned,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_stop_id = s.id) AS riders,
                 'Change stops on the Routes page.' AS "_locked"
            FROM route_stops s JOIN routes r ON r.id = s.route_id
           WHERE r.superseded_at IS NULL
           ORDER BY r.name, s.position, s.id`,
    countSql: `SELECT count(*)::int AS n FROM route_stops s JOIN routes r ON r.id = s.route_id
                WHERE r.superseded_at IS NULL`
  },
  members: {
    label: "Staff",
    columns: [
      col("name", "Name"), col("username", "Username"),
      col("email", "Email"), col("roles", "Roles"), col("status", "Status")
    ],
    sql: `SELECT m.id, m.display_name AS name, m.username, m.email,
                 (SELECT string_agg(initcap(mr.role), ', ' ORDER BY mr.role) FROM member_roles mr
                   WHERE mr.member_id = m.id AND mr.revoked_at IS NULL) AS roles,
                 CASE WHEN m.suspended_at IS NOT NULL THEN 'Suspended'
                      WHEN m.activated_at IS NULL THEN 'Invited' ELSE 'Active' END AS status,
                 'Change staff logins on the Members page.' AS "_locked"
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
const optionalPhone = z.string().trim().max(40, "Keep it under 40 characters.")
  .transform((value) => value || null)
  .refine((value) => value === null || /\d{7,}/.test(value.replace(/\D/g, "")), "That doesn't look like a phone number.");
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

type EditResult = { column: string; old: string | null; value: string | null };

async function editRider(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (row.locked) throw new EditError(409, row.locked);
  if (column === "first" || column === "last") {
    if (!sameAsShown(row.cells[column], from)) throw new EditError(409, STALE);
    const next = check(name80, value);
    await client.query(`UPDATE riders SET ${column === "first" ? "given_name" : "family_name"} = $2 WHERE id = $1`, [row.id, next]);
    return { column, old: from, value: next };
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
  await client.query(`UPDATE guardians SET ${column} = $2 WHERE id = $1`, [row.id, next]);
  return { column, old: from || null, value: next };
}

async function editBus(client: PoolClient, row: DataRow, column: string, from: string, value: string): Promise<EditResult> {
  if (column !== "label") throw new EditError(400, "That column can't be edited here.");
  if (!sameAsShown(row.cells.label, from)) throw new EditError(409, STALE);
  const next = check(name80, value);
  const taken = await client.query(`SELECT 1 FROM buses WHERE lower(label) = lower($1) AND id <> $2`, [next, row.id]);
  if (taken.rowCount) throw new EditError(409, `Another bus is already called "${next}".`);
  await client.query(`UPDATE buses SET label = $2 WHERE id = $1`, [row.id, next]);
  return { column, old: from, value: next };
}

const EDITORS: Partial<Record<DataTableKey, typeof editRider>> = {
  riders: editRider,
  guardians: editGuardian,
  buses: editBus
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
  if (!editor) {
    refuse(response, 403, `${TABLES[table.data].label} can't be edited from Data mode.`);
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockTable = table.data === "riders" ? "riders" : table.data === "guardians" ? "guardians" : "buses";
    const exists = await client.query(`SELECT 1 FROM ${lockTable} WHERE id = $1 FOR UPDATE`, [id.data]);
    if (!exists.rowCount) {
      await client.query("ROLLBACK");
      refuse(response, 404, "That row was deleted by someone else. Reload the table.");
      return;
    }
    const [before] = await readRows(client, table.data, id.data);
    let result: EditResult;
    try {
      result = await editor(client, before!, edit.data.column, edit.data.from, edit.data.value);
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
    response.json(dataEditResponseSchema.parse({ row: after }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
