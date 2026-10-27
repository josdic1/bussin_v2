import { Router } from "express";
import {
  dataTableKeySchema, dataTableResponseSchema, dataTablesResponseSchema,
  type DataCell, type DataTableKey
} from "@bussin/shared";
import { requireRole } from "../auth/guard.js";
import { pool } from "../db/pool.js";

// Data mode: every table the office manages, as a plain grid. Read-only for now.
// One entry per table: its label, its columns, and one SQL query that returns
// an "id" column plus one column per grid column, already joined into plain text.

type Column = { key: string; label: string };
type Table = { label: string; columns: Column[]; sql: string; countSql: string };

const ROW_LIMIT = 2000;

const TABLES: Record<DataTableKey, Table> = {
  riders: {
    label: "Riders",
    columns: [
      { key: "first", label: "First" }, { key: "last", label: "Last" },
      { key: "amRoute", label: "AM route" }, { key: "amStop", label: "AM stop" },
      { key: "pmRoute", label: "PM route" }, { key: "pmStop", label: "PM stop" },
      { key: "guardians", label: "Guardians" }, { key: "source", label: "Source" }
    ],
    sql: `SELECT r.id, r.given_name AS first, r.family_name AS last,
                 amr.name AS "amRoute", ams.label AS "amStop",
                 pmr.name AS "pmRoute", pms.label AS "pmStop",
                 (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM rider_guardian_links l
                    JOIN guardians g ON g.id = l.guardian_id WHERE l.rider_id = r.id) AS guardians,
                 CASE WHEN r.import_dataset IS NULL THEN 'Added in app' ELSE 'Imported' END AS source
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
      { key: "name", label: "Name" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
      { key: "access", label: "App access" }, { key: "riders", label: "Riders" }
    ],
    sql: `SELECT g.id, g.name, g.phone, g.email,
                 CASE WHEN g.member_id IS NULL THEN 'No login'
                      WHEN m.activated_at IS NOT NULL AND m.suspended_at IS NULL THEN 'Active'
                      ELSE 'Invited' END AS access,
                 (SELECT string_agg(r.given_name || ' ' || r.family_name, ', ' ORDER BY r.family_name, r.given_name)
                    FROM rider_guardian_links l JOIN riders r ON r.id = l.rider_id
                   WHERE l.guardian_id = g.id) AS riders
            FROM guardians g LEFT JOIN members m ON m.id = g.member_id
           ORDER BY g.name, g.id`,
    countSql: "SELECT count(*)::int AS n FROM guardians"
  },
  buses: {
    label: "Buses",
    columns: [{ key: "label", label: "Bus" }, { key: "status", label: "Status" }],
    sql: `SELECT id, label, CASE WHEN active THEN 'Active' ELSE 'Retired' END AS status
            FROM buses ORDER BY active DESC, label, id`,
    countSql: "SELECT count(*)::int AS n FROM buses"
  },
  routes: {
    label: "Routes",
    columns: [
      { key: "name", label: "Route" }, { key: "period", label: "AM or PM" },
      { key: "stops", label: "Stops" }, { key: "riders", label: "Riders" }, { key: "status", label: "Status" }
    ],
    sql: `SELECT r.id, r.name, upper(r.service_period) AS period,
                 (SELECT count(*)::int FROM route_stops s WHERE s.route_id = r.id) AS stops,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_id = r.id) AS riders,
                 CASE WHEN r.active THEN 'Active' ELSE 'Off' END AS status
            FROM routes r WHERE r.superseded_at IS NULL
           ORDER BY r.active DESC, r.name, r.id`,
    countSql: "SELECT count(*)::int AS n FROM routes WHERE superseded_at IS NULL"
  },
  stops: {
    label: "Stops",
    columns: [
      { key: "route", label: "Route" }, { key: "order", label: "Order" },
      { key: "label", label: "Stop" }, { key: "pinned", label: "On map" }, { key: "riders", label: "Riders" }
    ],
    sql: `SELECT s.id, r.name AS route, s.position AS "order", s.label,
                 CASE WHEN s.latitude IS NULL OR s.longitude IS NULL THEN 'No pin' ELSE 'Pinned' END AS pinned,
                 (SELECT count(*)::int FROM rider_stop_assignments a WHERE a.route_stop_id = s.id) AS riders
            FROM route_stops s JOIN routes r ON r.id = s.route_id
           WHERE r.superseded_at IS NULL
           ORDER BY r.name, s.position, s.id`,
    countSql: `SELECT count(*)::int AS n FROM route_stops s JOIN routes r ON r.id = s.route_id
                WHERE r.superseded_at IS NULL`
  },
  members: {
    label: "Staff",
    columns: [
      { key: "name", label: "Name" }, { key: "username", label: "Username" },
      { key: "email", label: "Email" }, { key: "roles", label: "Roles" }, { key: "status", label: "Status" }
    ],
    sql: `SELECT m.id, m.display_name AS name, m.username, m.email,
                 (SELECT string_agg(initcap(mr.role), ', ' ORDER BY mr.role) FROM member_roles mr
                   WHERE mr.member_id = m.id AND mr.revoked_at IS NULL) AS roles,
                 CASE WHEN m.suspended_at IS NOT NULL THEN 'Suspended'
                      WHEN m.activated_at IS NULL THEN 'Invited' ELSE 'Active' END AS status
            FROM members m
           WHERE EXISTS (SELECT 1 FROM member_roles mr WHERE mr.member_id = m.id
                           AND mr.revoked_at IS NULL AND mr.role <> 'family')
           ORDER BY m.display_name, m.id`,
    countSql: `SELECT count(*)::int AS n FROM members m
                WHERE EXISTS (SELECT 1 FROM member_roles mr WHERE mr.member_id = m.id
                                AND mr.revoked_at IS NULL AND mr.role <> 'family')`
  }
};

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

// One table as a grid.
dataRoutes.get("/:table", requireRole("admin"), async (request, response) => {
  const parsed = dataTableKeySchema.safeParse(request.params.table);
  if (!parsed.success) {
    response.status(404).json({ error: "No such table." });
    return;
  }
  const table = TABLES[parsed.data];
  const result = await pool.query<Record<string, DataCell> & { id: string }>(`${table.sql} LIMIT ${ROW_LIMIT}`);
  response.json(dataTableResponseSchema.parse({
    key: parsed.data,
    label: table.label,
    columns: table.columns,
    rows: result.rows.map(({ id, ...cells }) => ({ id, cells }))
  }));
});
