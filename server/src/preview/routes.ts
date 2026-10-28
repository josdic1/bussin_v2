import { Router } from "express";
import { z } from "zod";
import { previewPeopleSchema, staffCheckResponseSchema, staffTripResponseSchema } from "@bussin/shared";
import { requireRole } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { readMemberCheck } from "../check/routes.js";
import { readFamilyPortal } from "../families/routes.js";
import { readFamilyMessages } from "../messages/routes.js";
import { BUS_CHOSEN_TRIP } from "../device/routes.js";
import { readStaffTrip, STAFF_CHOSEN_TRIP } from "../staff/tripView.js";

// View as: the admin sees exactly what a parent, a counselor's phone or a bus phone shows.
// Read-only by construction: these are GET endpoints that reuse the phones' own readers,
// and nothing here can tap, start, finish or send GPS.

export const previewRoutes = Router();
const idSchema = z.string().uuid();

const TRIP_LABEL = `b.label || ' · ' || t.route_name || ' · ' ||
  CASE WHEN t.status = 'active' THEN 'running now' ELSE 'next trip' END`;

previewRoutes.get("/people", requireRole("admin"), async (_request, response) => {
  const [counselors, buses, parents] = await Promise.all([
    pool.query<{ id: string; name: string; trip: string | null }>(
      `SELECT m.id, m.display_name AS name,
              (SELECT ${TRIP_LABEL} FROM trips t JOIN buses b ON b.id = t.bus_id
                WHERE t.id = (${STAFF_CHOSEN_TRIP.replace("$1", "m.id")})) AS trip
         FROM members m
        WHERE m.suspended_at IS NULL
          AND EXISTS (SELECT 1 FROM member_roles r
                       WHERE r.member_id = m.id AND r.role = 'staff' AND r.revoked_at IS NULL)
        ORDER BY (SELECT 1 FROM staff_assignments a JOIN trips t ON t.id = a.trip_id
                   WHERE a.member_id = m.id AND a.ended_at IS NULL AND t.status IN ('planned', 'active') LIMIT 1) NULLS LAST,
                 m.display_name`),
    pool.query<{ id: string; label: string; trip: string | null; paired: boolean }>(
      `SELECT bus.id, bus.label,
              (SELECT ${TRIP_LABEL} FROM trips t JOIN buses b ON b.id = t.bus_id
                WHERE t.id = (${BUS_CHOSEN_TRIP.replace("$1", "bus.id")})) AS trip,
              EXISTS (SELECT 1 FROM bus_devices d WHERE d.bus_id = bus.id AND d.revoked_at IS NULL) AS paired
         FROM buses bus
        WHERE bus.active
        ORDER BY bus.label`),
    pool.query<{ id: string; name: string; kids: string; trip: string | null }>(
      `SELECT g.member_id AS id, g.name,
              coalesce((SELECT string_agg(r.given_name || ' ' || r.family_name, ', ' ORDER BY r.given_name)
                          FROM rider_guardian_links l JOIN riders r ON r.id = l.rider_id
                         WHERE l.guardian_id = g.id), '') AS kids,
              (SELECT ${TRIP_LABEL} FROM family_trip_access access
                 JOIN trips t ON t.id = access.trip_id JOIN buses b ON b.id = t.bus_id
                WHERE access.member_id = g.member_id AND t.status IN ('planned', 'active')
                ORDER BY (t.status = 'active') DESC, t.departure_at LIMIT 1) AS trip
         FROM guardians g
         JOIN members m ON m.id = g.member_id AND m.suspended_at IS NULL
        ORDER BY g.name`)
  ]);
  response.json(previewPeopleSchema.parse({ counselors: counselors.rows, buses: buses.rows, parents: parents.rows }));
});

previewRoutes.get("/counselor/:id/trip", requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a counselor." }); return; }
  const trip = await readStaffTrip(STAFF_CHOSEN_TRIP, [id.data], id.data);
  response.json(staffTripResponseSchema.parse({ trip }));
});

previewRoutes.get("/counselor/:id/check", requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a counselor." }); return; }
  response.json(staffCheckResponseSchema.parse({ trip: await readMemberCheck(id.data) }));
});

previewRoutes.get("/bus/:id/trip", requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a bus." }); return; }
  const trip = await readStaffTrip(BUS_CHOSEN_TRIP, [id.data]);
  response.json(staffTripResponseSchema.parse({ trip }));
});

previewRoutes.get("/parent/:id/portal", requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a parent." }); return; }
  response.json(await readFamilyPortal(id.data));
});

previewRoutes.get("/parent/:id/messages", requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose a parent." }); return; }
  response.json(await readFamilyMessages(id.data));
});
