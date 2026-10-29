import { Router } from "express";
import { z } from "zod";
import { tripAlertInputSchema, tripAlertLabel, tripAlertSchema, tripAlertsResponseSchema, type TripAlertKind } from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { subscribe } from "../db/listen.js";
import { openStream } from "../sse.js";
import { STAFF_CHOSEN_TRIP } from "../staff/tripView.js";

// Trip alerts. A counselor sends an update (running late, bathroom stop) or an emergency
// from their phone; it lands in Dispatch at once (SSE) and in the trip's record. Dispatch
// marks it handled, and the sender's phone shows that it was seen.

export const alertRoutes = Router();
const idSchema = z.string().uuid();
const rangeSchema = z.strictObject({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) });

type AlertRow = {
  id: string; tripId: string; busLabel: string; routeName: string; servicePeriod: "AM" | "PM";
  kind: TripAlertKind; code: string; note: string | null; latitude: number | null; longitude: number | null;
  sentBy: string; createdAt: Date; resolvedAt: Date | null; resolvedBy: string | null;
};

/** Alerts matching a WHERE clause on trip_alerts a, newest first. */
export async function readAlerts(where: string, values: unknown[]) {
  const result = await pool.query<AlertRow>(
    `SELECT a.id, a.trip_id AS "tripId", b.label AS "busLabel", t.route_name AS "routeName",
            r.service_period AS "servicePeriod", a.kind, a.code, a.note,
            a.latitude::double precision AS latitude, a.longitude::double precision AS longitude,
            sender.display_name AS "sentBy", a.created_at AS "createdAt",
            a.resolved_at AS "resolvedAt", resolver.display_name AS "resolvedBy"
       FROM trip_alerts a
       JOIN trips t ON t.id = a.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       JOIN members sender ON sender.id = a.recorded_by
       LEFT JOIN members resolver ON resolver.id = a.resolved_by
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT 200`, values);
  return result.rows.map((row) => tripAlertSchema.parse({
    ...row, label: tripAlertLabel(row.kind, row.code),
    createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null
  }));
}

/** A counselor's phone: send an update or emergency for the trip they're on. */
alertRoutes.post("/", requireSameOrigin, requireRole("staff"), async (request, response) => {
  const input = tripAlertInputSchema.safeParse(request.body);
  if (!input.success) { response.status(400).json({ error: input.error.issues[0]?.message ?? "Pick one of the choices." }); return; }
  const member = currentMember(response);
  const trip = await pool.query<{ tripId: string }>(`SELECT trip_id AS "tripId" FROM (${STAFF_CHOSEN_TRIP}) chosen`, [member.id]);
  if (!trip.rowCount) { response.status(409).json({ error: "You're not on a trip right now. Call Dispatch." }); return; }
  const created = await pool.query<{ id: string }>(
    `INSERT INTO trip_alerts (trip_id, kind, code, note, latitude, longitude, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [trip.rows[0]!.tripId, input.data.kind, input.data.code, input.data.note ?? null,
      input.data.latitude ?? null, input.data.longitude ?? null, member.id]);
  const [alert] = await readAlerts("a.id = $1", [created.rows[0]!.id]);
  response.status(201).json(alert);
});

/** A counselor's phone: what's been sent on my trip, and whether Dispatch has seen it. */
alertRoutes.get("/mine", requireRole("staff"), async (_request, response) => {
  const member = currentMember(response);
  const alerts = await readAlerts(`a.trip_id = (${STAFF_CHOSEN_TRIP})`, [member.id]);
  response.json(tripAlertsResponseSchema.parse({ alerts }));
});

/** Dispatch: every alert in a time range, plus anything still open from before it. */
alertRoutes.get("/", requireRole("admin", "dispatch"), async (request, response) => {
  const range = rangeSchema.safeParse(request.query);
  if (!range.success) { response.status(400).json({ error: "Choose a valid day." }); return; }
  const alerts = await readAlerts(
    `(a.created_at >= $1 AND a.created_at < $2) OR a.resolved_at IS NULL`, [range.data.from, range.data.to]);
  response.json(tripAlertsResponseSchema.parse({ alerts }));
});

alertRoutes.post("/:id/resolve", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) { response.status(400).json({ error: "Choose an alert." }); return; }
  const member = currentMember(response);
  const updated = await pool.query(
    `UPDATE trip_alerts SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`, [id.data, member.id]);
  if (!updated.rowCount) {
    const exists = await pool.query(`SELECT 1 FROM trip_alerts WHERE id = $1`, [id.data]);
    if (!exists.rowCount) { response.status(404).json({ error: "Alert not found." }); return; }
  }
  const [alert] = await readAlerts("a.id = $1", [id.data]);
  response.json(alert);
});

/** Dispatch: hear new and handled alerts the moment they happen. */
alertRoutes.get("/live", requireRole("admin", "dispatch"), async (_request, response) => {
  const stream = openStream(response);
  const unsubscribe = await subscribe("bussin_dispatch_alert", (payload) => stream.send("alert", payload));
  stream.onClose(unsubscribe);
  stream.send("ready", "{}");
});
