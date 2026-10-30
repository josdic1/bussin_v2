import { Router } from "express";
import { z } from "zod";
import { requireSameOrigin } from "../auth/guard.js";
import { setSessionCookie } from "../auth/cookies.js";
import { createSession, readSession } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import { demoActive } from "./mode.js";
import { resetDemo } from "./reset.js";

// Demo copy only: one-tap sign-in as the office, a parent or a counselor, and Reset.
// On the real server demoActive() is false and every route here answers 404,
// except GET /api/demo, which just says { demo: false }.

export const demoRoutes = Router();

type Who = "office" | "counselor" | "parent";
type Person = { id: string; name: string };
type Parent = { guardianId: string; memberId: string | null; name: string };

/** The people the demo signs you in as, picked so they share the first bus of the run. */
async function cast(): Promise<{ office: Person | null; counselor: Person | null; parent: Parent | null }> {
  const office = await pool.query<Person>(
    `SELECT m.id, m.display_name AS name FROM members m JOIN member_roles r ON r.member_id = m.id
      WHERE r.role = 'admin' AND r.revoked_at IS NULL AND m.suspended_at IS NULL
      ORDER BY m.created_at, m.id LIMIT 1`);
  const lead = await pool.query<Person & { tripId: string }>(
    `SELECT m.id, m.display_name AS name, t.id AS "tripId"
       FROM trips t
       JOIN staff_assignments a ON a.trip_id = t.id AND a.ended_at IS NULL AND a.crew_role = 'lead'
       JOIN members m ON m.id = a.member_id
      WHERE t.status IN ('planned', 'active') AND t.departure_at > now() - interval '6 hours'
      ORDER BY t.departure_at, t.id LIMIT 1`);
  const tripId = lead.rows[0]?.tripId ?? null;
  // A parent of a kid on that same bus, so their phone shows the bus you're watching.
  const parent = await pool.query<Parent>(
    `SELECT g.id AS "guardianId", m.id AS "memberId", g.name
       FROM guardians g
       JOIN rider_guardian_links l ON l.guardian_id = g.id
       LEFT JOIN members m ON m.id = g.member_id AND m.suspended_at IS NULL
        AND EXISTS (SELECT 1 FROM member_roles r WHERE r.member_id = m.id AND r.role = 'family' AND r.revoked_at IS NULL)
      WHERE g.email IS NOT NULL
      ORDER BY (l.rider_id IN (SELECT tr.rider_id FROM trip_riders tr WHERE tr.trip_id = $1)) DESC,
               (m.id IS NOT NULL) DESC, g.name, g.id
      LIMIT 1`, [tripId]);
  return {
    office: office.rows[0] ?? null,
    counselor: lead.rows[0] ? { id: lead.rows[0].id, name: lead.rows[0].name } : null,
    parent: parent.rows[0] ?? null
  };
}

/** The demo parent may not have a login yet. Give them one (demo copy only). */
async function familyLogin(parent: Parent | null): Promise<string | null> {
  if (!parent) return null;
  if (parent.memberId) return parent.memberId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = (await client.query<{ hash: string }>(`SELECT password_hash AS hash FROM members WHERE password_hash IS NOT NULL LIMIT 1`)).rows[0]?.hash;
    const made = await client.query<{ id: string }>(
      `INSERT INTO members (email, display_name, password_hash, activated_at)
       SELECT g.email, g.name, $2, now() FROM guardians g WHERE g.id = $1 RETURNING id`, [parent.guardianId, hash]);
    const id = made.rows[0]!.id;
    await client.query(`INSERT INTO member_roles (member_id, role) VALUES ($1, 'family')`, [id]);
    await client.query(`UPDATE guardians SET member_id = $2 WHERE id = $1`, [parent.guardianId, id]);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

demoRoutes.get("/", async (_request, response) => {
  if (!demoActive()) { response.json({ demo: false }); return; }
  const people = await cast();
  response.json({
    demo: true,
    people: Object.fromEntries(Object.entries(people).map(([who, person]) => [who, person?.name ?? null]))
  });
});

demoRoutes.use((_request, response, next) => {
  if (!demoActive()) { response.status(404).json({ error: "Not found" }); return; }
  next();
});

demoRoutes.post("/signin", requireSameOrigin, async (request, response) => {
  const input = z.strictObject({ as: z.enum(["office", "counselor", "parent"]) }).safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: "Pick who to sign in as." }); return; }
  const people = await cast();
  const memberId = input.data.as === "parent" ? await familyLogin(people.parent) : people[input.data.as]?.id ?? null;
  if (!memberId) { response.status(409).json({ error: "Nobody in the demo fits that. Press Reset and try again." }); return; }
  const token = await createSession(memberId);
  setSessionCookie(response, token);
  response.json({ member: await readSession(token), tenant: await readTenant() });
});

demoRoutes.post("/reset", requireSameOrigin, async (request, response) => {
  const input = z.strictObject({ period: z.enum(["AM", "PM"]).default("AM") }).safeParse(request.body ?? {});
  if (!input.success) { response.status(400).json({ error: "Pick morning or afternoon." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runs = await resetDemo(client, input.data.period);
    await client.query("COMMIT");
    response.json({ runs });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});
