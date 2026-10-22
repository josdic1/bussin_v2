import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  familyMessagesResponseSchema, messageReachSchema, messageTargetSchema, sendMessageInputSchema,
  sentMessagesResponseSchema, type MessageTarget
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";

export const messageRoutes = Router();

/** A guardian can read messages only with an activated, unsuspended family login. */
const HAS_LOGIN = `EXISTS (
  SELECT 1 FROM members m JOIN member_roles role ON role.member_id = m.id
   WHERE m.id = g.member_id AND m.activated_at IS NOT NULL AND m.suspended_at IS NULL
     AND role.role = 'family' AND role.revoked_at IS NULL)`;

type Audience = { label: string; guardians: { id: string; hasLogin: boolean }[] };

class NotFound extends Error {}

/** Works out the label and the exact guardians a message would go to right now. */
async function resolveAudience(client: PoolClient, target: MessageTarget): Promise<Audience> {
  let label: string;
  let guardianSql: string;
  let params: string[] = [];

  if (target.audience === "all") {
    label = "Everyone";
    guardianSql = `SELECT DISTINCT l.guardian_id AS id FROM rider_guardian_links l`;
  } else if (target.audience === "route") {
    const family = await client.query<{ name: string }>(`SELECT name FROM route_families WHERE id = $1`, [target.routeFamilyId]);
    if (!family.rowCount) throw new NotFound("That route no longer exists.");
    label = family.rows[0].name;
    params = [target.routeFamilyId];
    guardianSql = `SELECT DISTINCT l.guardian_id AS id
                     FROM rider_stop_assignments a
                     JOIN routes r ON r.id = a.route_id AND r.route_family_id = $1
                     JOIN rider_guardian_links l ON l.rider_id = a.rider_id`;
  } else if (target.audience === "trip") {
    const trip = await client.query<{ bus: string; route: string }>(
      `SELECT b.label AS bus, r.name AS route FROM trips t
         JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id WHERE t.id = $1`, [target.tripId]);
    if (!trip.rowCount) throw new NotFound("That trip no longer exists.");
    label = `${trip.rows[0].bus} · ${trip.rows[0].route}`;
    params = [target.tripId];
    // Riders put on the trip, plus anyone assigned to its route (covers trips planned before a rider was added).
    guardianSql = `SELECT DISTINCT l.guardian_id AS id FROM rider_guardian_links l
                    WHERE l.rider_id IN (
                      SELECT tr.rider_id FROM trip_riders tr WHERE tr.trip_id = $1
                      UNION
                      SELECT a.rider_id FROM rider_stop_assignments a JOIN trips t ON t.route_id = a.route_id WHERE t.id = $1)`;
  } else {
    const rider = await client.query<{ name: string }>(
      `SELECT given_name || ' ' || family_name AS name FROM riders WHERE id = $1`, [target.riderId]);
    if (!rider.rowCount) throw new NotFound("That rider no longer exists.");
    label = `${rider.rows[0].name}'s family`;
    params = [target.riderId];
    guardianSql = `SELECT DISTINCT l.guardian_id AS id FROM rider_guardian_links l WHERE l.rider_id = $1`;
  }

  const result = await client.query<{ id: string; hasLogin: boolean }>(
    `SELECT g.id, ${HAS_LOGIN} AS "hasLogin" FROM guardians g WHERE g.id IN (${guardianSql}) ORDER BY g.id`, params);
  return { label, guardians: result.rows };
}

function reach(audience: Audience) {
  return messageReachSchema.parse({
    label: audience.label,
    guardians: audience.guardians.length,
    withLogin: audience.guardians.filter((guardian) => guardian.hasLogin).length
  });
}

/** Admin: who a message would reach, before sending. */
messageRoutes.post("/preview", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const target = messageTargetSchema.safeParse(request.body);
  if (!target.success) {
    response.status(400).json({ error: "Choose who the message is for." });
    return;
  }
  const client = await pool.connect();
  try {
    response.json(reach(await resolveAudience(client, target.data)));
  } catch (error) {
    if (error instanceof NotFound) { response.status(404).json({ error: error.message }); return; }
    throw error;
  } finally { client.release(); }
});

/** Admin: every message sent, newest first, with how many guardians have read it. */
messageRoutes.get("/", requireRole("admin"), async (_request, response) => {
  const result = await pool.query(
    `SELECT m.id, m.body, m.audience, m.audience_label AS "audienceLabel", m.sent_by_name AS "sentBy",
            to_json(m.sent_at) #>> '{}' AS "sentAt", to_json(m.retracted_at) #>> '{}' AS "retractedAt",
            count(r.guardian_id)::int AS guardians,
            count(r.guardian_id) FILTER (WHERE ${HAS_LOGIN})::int AS "withLogin",
            count(r.read_at)::int AS "readBy"
       FROM family_messages m
       LEFT JOIN family_message_recipients r ON r.message_id = m.id
       LEFT JOIN guardians g ON g.id = r.guardian_id
      GROUP BY m.id
      ORDER BY m.sent_at DESC
      LIMIT 200`
  );
  response.json(sentMessagesResponseSchema.parse({ messages: result.rows }));
});

/** Admin: send. The recipient list is fixed at this moment. */
messageRoutes.post("/", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const input = sendMessageInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Write a message (up to 1,000 characters) and choose who it is for." });
    return;
  }
  const member = currentMember(response);
  const { target, body } = input.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const audience = await resolveAudience(client, target);
    if (!audience.guardians.length) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: `Nobody would get this. ${audience.label} has no linked guardians.` });
      return;
    }
    const saved = await client.query<{ id: string }>(
      `INSERT INTO family_messages (body, audience, route_family_id, trip_id, rider_id, audience_label, sent_by, sent_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [body, target.audience,
        target.audience === "route" ? target.routeFamilyId : null,
        target.audience === "trip" ? target.tripId : null,
        target.audience === "rider" ? target.riderId : null,
        audience.label, member.id, member.display_name]
    );
    await client.query(
      `INSERT INTO family_message_recipients (message_id, guardian_id)
       SELECT $1, unnest($2::uuid[])`,
      [saved.rows[0].id, audience.guardians.map((guardian) => guardian.id)]
    );
    await client.query("COMMIT");
    response.status(201).json({ id: saved.rows[0].id, ...reach(audience) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof NotFound) { response.status(404).json({ error: error.message }); return; }
    throw error;
  } finally { client.release(); }
});

/** Admin: take a message back. Families stop seeing it; the admin history keeps it, marked removed. */
messageRoutes.post("/:id/retract", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid message." });
    return;
  }
  const result = await pool.query(
    `UPDATE family_messages SET retracted_at = COALESCE(retracted_at, now()) WHERE id = $1`, [id.data]);
  if (!result.rowCount) {
    response.status(404).json({ error: "Message not found." });
    return;
  }
  response.json({ ok: true });
});

/** Family: my messages, newest first. */
messageRoutes.get("/mine", requireRole("family"), async (_request, response) => {
  const member = currentMember(response);
  const result = await pool.query(
    `SELECT m.id, m.body, m.audience_label AS "audienceLabel", to_json(m.sent_at) #>> '{}' AS "sentAt",
            bool_and(r.read_at IS NOT NULL) AS read
       FROM family_message_recipients r
       JOIN guardians g ON g.id = r.guardian_id AND g.member_id = $1
       JOIN family_messages m ON m.id = r.message_id AND m.retracted_at IS NULL
      GROUP BY m.id
      ORDER BY m.sent_at DESC
      LIMIT 50`,
    [member.id]
  );
  response.json(familyMessagesResponseSchema.parse({ messages: result.rows }));
});

/** Family: mark everything I can see as read. */
messageRoutes.post("/mine/read", requireSameOrigin, requireRole("family"), async (_request, response) => {
  const member = currentMember(response);
  await pool.query(
    `UPDATE family_message_recipients r SET read_at = now()
       FROM guardians g
      WHERE g.id = r.guardian_id AND g.member_id = $1 AND r.read_at IS NULL`,
    [member.id]
  );
  response.json({ ok: true });
});
