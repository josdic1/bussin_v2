import type { Request, Response } from "express";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";

// The master roster as one spreadsheet: one row per rider.
//   Rider key | First | Last | Source | AM route | AM stop | PM route | PM stop |
//   Guardian 1 | Guardian 1 phone | Guardian 1 email | Guardian 1 app access | Guardian 2 ...
// Read-only. Opens in Excel, Numbers or Google Sheets.

type RiderRow = { id: string; first: string; last: string; imported: boolean; careNotes: string | null; emergencyName: string | null; emergencyPhone: string | null };
type StopRow = { riderId: string; direction: "AM" | "PM"; route: string; stop: string };
type GuardianRow = {
  riderId: string; name: string; phone: string | null; email: string | null;
  access: "none" | "pending" | "active";
};

const ACCESS_LABEL = { none: "No login", pending: "Invited", active: "Active" } as const;

// Quote every cell. A cell starting with = + - @ would run as a formula in Excel,
// so it gets a leading apostrophe (Excel hides it and shows plain text).
export function cell(value: string | null | undefined): string {
  let text = value ?? "";
  // Plain numbers (a negative longitude) are safe and stay numbers.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function rosterCsv(_request: Request, response: Response): Promise<void> {
  const client = await pool.connect();
  let riders: RiderRow[];
  let stops: StopRow[];
  let guardians: GuardianRow[];
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    riders = (await client.query<RiderRow>(
      `SELECT id, given_name AS first, family_name AS last,
              import_dataset IS NOT NULL AS imported, care_notes AS "careNotes",
              emergency_name AS "emergencyName", emergency_phone AS "emergencyPhone"
         FROM riders ORDER BY family_name, given_name, id`
    )).rows;
    stops = (await client.query<StopRow>(
      `SELECT a.rider_id AS "riderId", a.direction, r.name AS route, s.label AS stop
         FROM rider_stop_assignments a
         JOIN routes r ON r.id = a.route_id
         JOIN route_stops s ON s.route_id = a.route_id AND s.id = a.route_stop_id`
    )).rows;
    guardians = (await client.query<GuardianRow>(
      `SELECT l.rider_id AS "riderId", g.name, g.phone, g.email,
              CASE WHEN g.member_id IS NULL THEN 'none'
                   WHEN m.activated_at IS NOT NULL AND m.suspended_at IS NULL
                    AND EXISTS (SELECT 1 FROM member_roles role WHERE role.member_id = m.id
                                AND role.role = 'family' AND role.revoked_at IS NULL)
                   THEN 'active' ELSE 'pending' END AS access
         FROM rider_guardian_links l
         JOIN guardians g ON g.id = l.guardian_id
         LEFT JOIN members m ON m.id = g.member_id
        ORDER BY l.rider_id, g.name, g.id`
    )).rows;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const am = new Map<string, StopRow>();
  const pm = new Map<string, StopRow>();
  for (const s of stops) (s.direction === "AM" ? am : pm).set(s.riderId, s);
  const byRider = new Map<string, GuardianRow[]>();
  for (const g of guardians) byRider.set(g.riderId, [...(byRider.get(g.riderId) ?? []), g]);
  const most = Math.max(1, ...[...byRider.values()].map((list) => list.length));

  const header = ["Rider key", "First", "Last", "Source", "AM route", "AM stop", "PM route", "PM stop",
    "Care notes", "Emergency contact", "Emergency phone"];
  for (let n = 1; n <= most; n += 1) {
    header.push(`Guardian ${n}`, `Guardian ${n} phone`, `Guardian ${n} email`, `Guardian ${n} app access`);
  }

  const lines = [header.map(cell).join(",")];
  for (const r of riders) {
    const row: (string | null | undefined)[] = [
      r.id, r.first, r.last, r.imported ? "Imported" : "Added in app",
      am.get(r.id)?.route, am.get(r.id)?.stop, pm.get(r.id)?.route, pm.get(r.id)?.stop,
      r.careNotes, r.emergencyName, r.emergencyPhone
    ];
    const list = byRider.get(r.id) ?? [];
    for (let n = 0; n < most; n += 1) {
      const g = list[n];
      row.push(g?.name, g?.phone, g?.email, g ? ACCESS_LABEL[g.access] : "");
    }
    lines.push(row.map(cell).join(","));
  }

  const tenant = await readTenant();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="${tenant.key}-roster-${day}.csv"`);
  response.setHeader("Cache-Control", "no-store");
  // The BOM tells Excel the file is UTF-8, so names with accents come out right.
  response.send(`﻿${lines.join("\r\n")}\r\n`);
}
