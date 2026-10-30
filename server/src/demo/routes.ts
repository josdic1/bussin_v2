import { Router } from "express";
import { z } from "zod";
import { requireSameOrigin } from "../auth/guard.js";
import { setSessionCookie } from "../auth/cookies.js";
import { createSession, readSession } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import { demoActive } from "./mode.js";
import { resetDemo } from "./reset.js";
import { buildCamp } from "./build.js";
import { fillHistory } from "./history.js";
import { clearDemo, deleteRide } from "./clear.js";
import { refreshRouteGeometry } from "../routes/save.js";

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
  const [people, counts, tenant] = await Promise.all([cast(), pool.query<{ buses: number; kids: number }>(
    `SELECT (SELECT count(*) FROM buses)::int AS buses, (SELECT count(*) FROM riders)::int AS kids`), readTenant()]);
  response.json({
    demo: true,
    // No buses yet means nobody has built a camp: show the welcome page.
    ready: counts.rows[0]!.buses > 0,
    camp: tenant.name,
    size: counts.rows[0],
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

/** Build a camp of the size asked for. Replaces everything except the admin login. */
demoRoutes.post("/build", requireSameOrigin, async (request, response) => {
  const input = z.strictObject({
    campName: z.string().trim().min(1, "Give the camp a name.").max(60),
    buses: z.number().int().min(1, "At least 1 bus.").max(16, "Up to 16 buses in the demo."),
    kids: z.number().int().min(1, "At least 1 kid.").max(600, "Up to 600 kids in the demo."),
    history: z.enum(["none", "day", "week", "month", "season"]).default("week")
  }).safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Check the numbers." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const built = await buildCamp(client, input.data);
    const past = input.data.history === "none" ? { trips: 0 } : await fillHistory(client, input.data.history);
    await client.query("COMMIT");
    for (const id of built.routeIds) refreshRouteGeometry(id);
    response.json({ buses: built.buses, kids: built.kids, families: built.families, staff: built.staff, runs: built.runs, history: past.trips });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

/** Fill in past days (only days that don't have their trips yet). */
demoRoutes.post("/history", requireSameOrigin, async (request, response) => {
  const input = z.strictObject({ span: z.enum(["day", "week", "month", "season"]) }).safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: "Pick a day, a week, a month or the season." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fillHistory(client, input.data.span);
    await client.query("COMMIT");
    response.json(result);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

/** Custom reset: wipe what isn't ticked. The admin login always stays. */
demoRoutes.post("/clear", requireSameOrigin, async (request, response) => {
  const input = z.strictObject({
    setup: z.boolean(), team: z.boolean(), kids: z.boolean(), history: z.boolean(), messages: z.boolean()
  }).safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: "Choose what to keep." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await clearDemo(client, input.data);
    await client.query("COMMIT");
    response.json(result);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

/** Delete one ride, whatever state it's in. */
demoRoutes.delete("/trips/:id", requireSameOrigin, async (request, response) => {
  const id = z.string().uuid().safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a ride." }); return; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const gone = await deleteRide(client, id.data);
    await client.query("COMMIT");
    if (!gone) { response.status(404).json({ error: "That ride is already gone." }); return; }
    response.json({ deleted: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});
