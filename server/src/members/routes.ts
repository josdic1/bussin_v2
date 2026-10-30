import { Router } from "express";
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  createStaffMemberSchema,
  staffMemberSchema,
  staffMembersResponseSchema,
  staffPasswordResetSchema,
  staffScheduleResponseSchema,
  staffStatusInputSchema,
  suggestUsername,
  updateStaffMemberSchema,
  usernameSuggestionSchema
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { hashPassword } from "../auth/sessions.js";
import { pool } from "../db/pool.js";

export const memberRoutes = Router();

type StaffRow = {
  id: string;
  displayName: string;
  username: string | null;
  roles: ("admin" | "dispatch" | "staff")[];
  email: string | null;
  phone: string | null;
  passwordChangeRequired: boolean;
  suspended: boolean;
};

const STAFF_COLUMNS = `m.id,
            m.display_name AS "displayName",
            m.username,
            m.email,
            m.phone,
            ARRAY(SELECT r.role FROM member_roles r
                   WHERE r.member_id = m.id AND r.revoked_at IS NULL AND r.role <> 'family'
                   ORDER BY array_position(ARRAY['admin', 'dispatch', 'staff'], r.role::text)) AS roles,
            m.password_change_required AS "passwordChangeRequired",
            m.suspended_at IS NOT NULL AS suspended`;

const IS_TEAM = `EXISTS (SELECT 1 FROM member_roles r
                     WHERE r.member_id = m.id AND r.revoked_at IS NULL AND r.role <> 'family')`;

async function readStaff(db: PoolClient | typeof pool, id: string) {
  const result = await db.query<StaffRow>(`SELECT ${STAFF_COLUMNS} FROM members m WHERE m.id = $1 AND ${IS_TEAM}`, [id]);
  return result.rows[0] ? staffMemberSchema.parse(result.rows[0]) : null;
}

/** First name + last initial, checked against every login (staff and family). */
export async function freeUsername(db: PoolClient | typeof pool, fullName: string, alsoTaken: Set<string> = new Set(), exceptId: string | null = null) {
  const rows = await db.query<{ username: string }>(
    `SELECT username FROM members WHERE username IS NOT NULL AND ($1::uuid IS NULL OR id <> $1)`, [exceptId]);
  const taken = new Set([...rows.rows.map((row) => row.username.toLowerCase()), ...alsoTaken]);
  return suggestUsername(fullName, (name) => taken.has(name));
}

memberRoutes.get("/username", requireRole("admin"), async (request, response) => {
  const name = typeof request.query.name === "string" ? request.query.name.slice(0, 120) : "";
  response.json(usernameSuggestionSchema.parse({ username: name.trim() ? await freeUsername(pool, name) : "" }));
});

memberRoutes.get("/", requireRole("admin"), async (_request, response) => {
  const result = await pool.query<StaffRow>(
    `SELECT ${STAFF_COLUMNS} FROM members m WHERE ${IS_TEAM} ORDER BY m.display_name, m.username, m.id`
  );

  response.json(staffMembersResponseSchema.parse({ staff: result.rows }));
});


memberRoutes.get("/schedule", requireRole("admin"), async (request, response) => {
  const from = typeof request.query.from === "string" ? new Date(request.query.from) : null;
  const to = typeof request.query.to === "string" ? new Date(request.query.to) : null;

  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) ||
      to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 8 * 24 * 60 * 60 * 1000) {
    response.status(400).json({ error: "Choose a schedule window of up to eight days." });
    return;
  }

  const result = await pool.query<{
    memberId: string;
    displayName: string;
    tripId: string;
    routeName: string;
    servicePeriod: "AM" | "PM";
    busLabel: string;
    departureAt: Date;
    status: "planned" | "active" | "completed" | "cancelled";
  }>(
    `WITH chosen_assignment AS (
       -- Everyone on each trip's crew (lead and counselors): open seats, or for a
       -- finished trip, whoever was still on it when it ended.
       SELECT DISTINCT ON (a.trip_id, a.member_id)
              a.trip_id, a.member_id
         FROM staff_assignments a
         JOIN trips t ON t.id = a.trip_id
        WHERE t.departure_at >= $1
          AND t.departure_at < $2
          AND (a.ended_at IS NULL OR a.ended_at >= COALESCE(t.ended_at, t.cancelled_at))
        ORDER BY a.trip_id, a.member_id, (a.ended_at IS NULL) DESC, a.assigned_at DESC, a.id DESC
     )
     SELECT m.id AS "memberId",
            m.display_name AS "displayName",
            t.id AS "tripId",
            t.route_name AS "routeName",
            r.service_period AS "servicePeriod",
            b.label AS "busLabel",
            t.departure_at AS "departureAt",
            t.status
       FROM chosen_assignment ca
       JOIN members m ON m.id = ca.member_id
       JOIN trips t ON t.id = ca.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
      ORDER BY t.departure_at, m.display_name, t.id`,
    [from, to]
  );

  response.json(staffScheduleResponseSchema.parse({
    entries: result.rows.map((row) => ({
      ...row,
      departureAt: row.departureAt.toISOString()
    }))
  }));
});

memberRoutes.post(
  "/",
  requireSameOrigin,
  requireRole("admin"),
  async (request, response) => {
    const parsed = createStaffMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Enter a name, valid username, optional email, and a temporary password of at least 12 characters."
      });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.temporaryPassword);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<StaffRow>(
        `INSERT INTO members
           (display_name, username, email, password_hash, activated_at, password_change_required, phone)
         VALUES ($1, $2, $3, $4, now(), true, $5)
         RETURNING id,
                   display_name AS "displayName",
                   username,
                   email,
                   phone,
                   ARRAY['staff']::text[] AS roles,
                   password_change_required AS "passwordChangeRequired",
                   suspended_at IS NOT NULL AS suspended`,
        [
          parsed.data.displayName,
          parsed.data.username,
          parsed.data.email,
          passwordHash,
          parsed.data.phone ?? null
        ]
      );

      await client.query(
        `INSERT INTO member_roles (member_id, role) VALUES ($1, 'staff')`,
        [result.rows[0].id]
      );

      await client.query("COMMIT");
      response.status(201).json(staffMemberSchema.parse(result.rows[0]));
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response.status(409).json({ error: "That username or email is already in use." });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }
);


// ---------- Changing one login: details, suspend, password ----------

const idSchema = z.string().uuid();

/** Name, username and email. Username and email must each be unused by any other login. */
memberRoutes.put("/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = updateStaffMemberSchema.safeParse(request.body);
  if (!id.success || !input.success) {
    response.status(400).json({ error: input.success ? "Login not found." : input.error.issues[0]?.message ?? "Check the details." });
    return;
  }
  const clash = await pool.query<{ username: string | null; email: string | null }>(
    `SELECT username, email FROM members WHERE id <> $1 AND (lower(username) = $2 OR ($3::text IS NOT NULL AND lower(email) = $3))`,
    [id.data, input.data.username, input.data.email]
  );
  const hit = clash.rows[0];
  if (hit) {
    response.status(409).json({ error: hit.username?.toLowerCase() === input.data.username
      ? `The username ${input.data.username} is taken. Try ${await freeUsername(pool, input.data.displayName, new Set(), id.data)}.`
      : "Another login already uses that email." });
    return;
  }
  const updated = await pool.query(
    `UPDATE members m SET display_name = $2, username = $3, email = $4,
            phone = CASE WHEN $5 THEN $6 ELSE phone END
      WHERE m.id = $1 AND ${IS_TEAM}`,
    [id.data, input.data.displayName, input.data.username, input.data.email, input.data.phone !== undefined, input.data.phone ?? null]
  );
  if (!updated.rowCount) { response.status(404).json({ error: "Login not found." }); return; }
  response.json(await readStaff(pool, id.data));
});

/** Suspend (signs them out everywhere) or reactivate. Never yourself, never the last admin. */
memberRoutes.post("/:id/status", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const input = staffStatusInputSchema.safeParse(request.body);
  if (!id.success || !input.success) { response.status(400).json({ error: "Choose a login." }); return; }
  if (input.data.suspended && id.data === currentMember(response).id) {
    response.status(409).json({ error: "You can't suspend yourself." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One admin change at a time, so two admins can't suspend each other at once.
    await client.query("SELECT pg_advisory_xact_lock(472912)");
    if (input.data.suspended) {
      const others = await client.query(
        `SELECT 1 FROM members m JOIN member_roles r ON r.member_id = m.id AND r.role = 'admin' AND r.revoked_at IS NULL
          WHERE m.id <> $1 AND m.suspended_at IS NULL LIMIT 1`, [id.data]);
      const isAdmin = await client.query(
        `SELECT 1 FROM member_roles WHERE member_id = $1 AND role = 'admin' AND revoked_at IS NULL`, [id.data]);
      if (isAdmin.rowCount && !others.rowCount) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Bussin needs at least one active admin." });
        return;
      }
      await client.query(`UPDATE members SET suspended_at = COALESCE(suspended_at, now()) WHERE id = $1`, [id.data]);
      await client.query(`UPDATE sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [id.data]);
    } else {
      await client.query(`UPDATE members SET suspended_at = NULL WHERE id = $1`, [id.data]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  const person = await readStaff(pool, id.data);
  if (!person) { response.status(404).json({ error: "Login not found." }); return; }
  response.json(person);
});

const PASSWORD_WORDS = ["Maple", "River", "Cedar", "Harbor", "Meadow", "Summit", "Willow", "Canyon", "Falcon", "Juniper"];

/** New temporary password, shown once. Signs them out; they set their own at next sign-in. */
memberRoutes.post("/:id/reset-password", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a login." }); return; }
  if (id.data === currentMember(response).id) {
    response.status(409).json({ error: "To change your own password, use Password at the bottom of the sidebar." });
    return;
  }
  const pick = () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]!;
  const temporaryPassword = `${pick()}-${pick()}-${randomInt(1000, 10000)}`;
  const hash = await hashPassword(temporaryPassword);
  const updated = await pool.query(
    `UPDATE members m SET password_hash = $2, password_change_required = true WHERE m.id = $1 AND ${IS_TEAM}`,
    [id.data, hash]
  );
  if (!updated.rowCount) { response.status(404).json({ error: "Login not found." }); return; }
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [id.data]);
  response.json(staffPasswordResetSchema.parse({ temporaryPassword }));
});
