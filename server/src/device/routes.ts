import { randomInt } from "node:crypto";
import { Router } from "express";
import {
  deviceMeResponseSchema,
  pairCodeResponseSchema,
  pairDeviceInputSchema,
  staffLocationSampleInputSchema,
  staffLocationSampleResponseSchema,
  staffTripResponseSchema,
  trackersResponseSchema,
  tripActionResponseSchema,
  tripActionSchema
} from "@bussin/shared";
import { currentMember, requireRole, requireSameOrigin } from "../auth/guard.js";
import { pool } from "../db/pool.js";
import { readTenant } from "../db/tenant.js";
import { clientIp, FailureLimiter } from "../http.js";
import { openStream } from "../sse.js";
import { ingestLocation } from "../staff/locationIngest.js";
import { subscribeToStaffTrips } from "../staff/live.js";
import { readStaffTrip } from "../staff/tripView.js";
import { applyTripAction } from "../trips/actions.js";
import {
  clearDeviceCookie,
  currentDevice,
  hashSecret,
  newDeviceToken,
  requireDevice,
  setDeviceCookie
} from "./auth.js";

// ---------------------------------------------------------------------------
// The bus tracker: a phone mounted on a bus, signed in as the bus.
// It follows whatever trip its bus is running and is that bus's GPS source.
// It can record arrive / depart / undo arrival. Starting and finishing a trip
// stay with the lead counselor (and auto-finish). Its stop events are recorded
// as the trip's lead counselor, because the trip log needs a person.
// ---------------------------------------------------------------------------

export const deviceRoutes = Router();

const PAIR_CODE_MINUTES = 15;
const WINDOW_MS = 15 * 60 * 1000;
// Wrong codes: 10 per address and 100 across everyone per 15 minutes. With 6 digits
// that keeps a guess at a live code far below a 1-in-5,000 chance.
const addressFailures = new FailureLimiter(10, WINDOW_MS);
const globalFailures = new FailureLimiter(100, WINDOW_MS);

/** The bus's trip: the running one first, otherwise the next planned one today or later. */
/** The bus phone: its bus's running trip, else the next planned one. Also used by View as. */
export const BUS_CHOSEN_TRIP = `
         SELECT t.id AS trip_id
           FROM trips t
          WHERE t.bus_id = $1
            AND (t.status = 'active'
                 OR (t.status = 'planned' AND t.departure_at >= date_trunc('day', now()) - interval '12 hours'))
          ORDER BY (t.status = 'active') DESC, t.departure_at ASC, t.id
          LIMIT 1
`;

deviceRoutes.post("/pair", requireSameOrigin, async (request, response) => {
  const ip = clientIp(request);
  const wait = Math.max(addressFailures.retryAfter(ip), globalFailures.retryAfter("all"));
  if (wait) {
    response.set("Retry-After", String(wait));
    response.status(429).json({ error: `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.` });
    return;
  }
  const input = pairDeviceInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Enter the 6-digit code from Fleet." });
    return;
  }

  const token = newDeviceToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const code = await client.query<{ id: string; busId: string; createdBy: string; label: string }>(
      `SELECT c.id, c.bus_id AS "busId", c.created_by AS "createdBy", b.label
         FROM bus_pair_codes c JOIN buses b ON b.id = c.bus_id
        WHERE c.code_hash = $1 AND c.used_at IS NULL AND c.expires_at > now()
        FOR UPDATE OF c`,
      [hashSecret(input.data.code)]
    );
    const found = code.rows[0];
    if (!found) {
      await client.query("ROLLBACK");
      addressFailures.fail(ip);
      globalFailures.fail("all");
      response.status(400).json({ error: "That code didn't work. Codes last 15 minutes and work once. Make a new one in Fleet." });
      return;
    }
    await client.query("UPDATE bus_pair_codes SET used_at = now() WHERE id = $1", [found.id]);
    // One tracker per bus: pairing a new phone retires the old one.
    await client.query(
      "UPDATE bus_devices SET revoked_at = GREATEST(now(), paired_at) WHERE bus_id = $1 AND revoked_at IS NULL",
      [found.busId]
    );
    await client.query(
      "INSERT INTO bus_devices (bus_id, token_hash, paired_by) VALUES ($1, $2, $3)",
      [found.busId, hashSecret(token), found.createdBy]
    );
    await client.query("COMMIT");
    addressFailures.clear(ip);
    setDeviceCookie(response, token);
    const tenant = await readTenant();
    response.json(deviceMeResponseSchema.parse({ bus: { id: found.busId, label: found.label }, tenant: tenant.name }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

deviceRoutes.get("/me", requireDevice, async (_request, response) => {
  const device = currentDevice(response);
  const tenant = await readTenant();
  response.json(deviceMeResponseSchema.parse({ bus: { id: device.busId, label: device.busLabel }, tenant: tenant.name }));
});

/** The phone unpairs itself (from the screen's menu). */
deviceRoutes.post("/unpair", requireSameOrigin, requireDevice, async (_request, response) => {
  const device = currentDevice(response);
  await pool.query("UPDATE bus_devices SET revoked_at = GREATEST(now(), paired_at) WHERE id = $1 AND revoked_at IS NULL", [device.id]);
  clearDeviceCookie(response);
  response.status(204).end();
});

/** Nothing to store: requireDevice already marks the tracker as seen. */
deviceRoutes.post("/presence", requireSameOrigin, requireDevice, (_request, response) => {
  response.status(204).end();
});

deviceRoutes.get("/trip", requireDevice, async (_request, response) => {
  const device = currentDevice(response);
  const trip = await readStaffTrip(BUS_CHOSEN_TRIP, [device.busId]);
  response.json(staffTripResponseSchema.parse({ trip }));
});

deviceRoutes.get("/live", requireDevice, async (_request, response) => {
  const stream = openStream(response);
  // Trip notifications name a member, not a bus. Any change nudges the tracker to
  // re-read its trip, at most once every 2 seconds; the read itself is small.
  let timer: NodeJS.Timeout | null = null;
  const unsubscribe = await subscribeToStaffTrips(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; stream.send("trip", "{}"); }, 2_000);
  });
  stream.onClose(() => { if (timer) clearTimeout(timer); unsubscribe(); });
  stream.send("ready", "{}");
});

/** The bus's running trip and its lead counselor, if the trip is still on this bus. */
async function runningTrip(busId: string, tripId?: string) {
  const result = await pool.query<{ tripId: string; leadId: string | null }>(
    `SELECT t.id AS "tripId",
            (SELECT a.member_id FROM staff_assignments a
              WHERE a.trip_id = t.id AND a.ended_at IS NULL AND a.crew_role = 'lead'
              LIMIT 1) AS "leadId"
       FROM trips t
      WHERE t.bus_id = $1 AND t.status = 'active' AND ($2::uuid IS NULL OR t.id = $2)
      ORDER BY t.started_at DESC
      LIMIT 1`,
    [busId, tripId ?? null]
  );
  return result.rows[0] ?? null;
}

deviceRoutes.post("/trip/actions", requireSameOrigin, requireDevice, async (request, response) => {
  const action = tripActionSchema.safeParse(request.body);
  if (!action.success || !["arrive", "depart", "undo_arrival"].includes(action.data.type)) {
    response.status(400).json({ error: "The lead counselor starts and finishes the trip on their phone." });
    return;
  }
  const device = currentDevice(response);
  const trip = await runningTrip(device.busId);
  if (!trip) {
    response.status(409).json({ error: "This bus has no running trip." });
    return;
  }
  if (!trip.leadId) {
    response.status(409).json({ error: "This trip has no lead counselor. Ask Dispatch." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const outcome = await applyTripAction(client, {
      tripId: trip.tripId,
      action: action.data,
      actorId: trip.leadId,
      eventNote: "device:tap"
    });
    if (!outcome.ok) {
      await client.query("ROLLBACK");
      response.status(outcome.httpStatus).json({ error: outcome.error });
      return;
    }
    await client.query("COMMIT");
    response.json(tripActionResponseSchema.parse({ status: outcome.status }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

deviceRoutes.post("/trip/location", requireSameOrigin, requireDevice, async (request, response) => {
  const input = staffLocationSampleInputSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Choose a valid location sample." });
    return;
  }
  const device = currentDevice(response);
  const trip = await runningTrip(device.busId, input.data.tripId);
  if (!trip) {
    response.status(409).json({ error: "That trip isn't running on this bus anymore." });
    return;
  }
  const duplicate = await pool.query(
    `SELECT 1 FROM trip_location_samples
      WHERE trip_id = $1 AND (client_sample_id = $2 OR observed_at = $3::timestamptz) LIMIT 1`,
    [input.data.tripId, input.data.clientSampleId, input.data.observedAt]
  );
  if (duplicate.rowCount) {
    response.status(200).json(staffLocationSampleResponseSchema.parse({ accepted: false, reason: "duplicate" }));
    return;
  }
  await ingestLocation(response, input.data, { deviceId: device.id }, trip.leadId);
});

// ---------------------------------------------------------------------------
// Fleet side: make a pairing code, list trackers, unpair. Admin and Dispatch.
// ---------------------------------------------------------------------------

export const trackerRoutes = Router();

trackerRoutes.get("/trackers", requireRole("admin", "dispatch"), async (_request, response) => {
  const result = await pool.query<{ busId: string; pairedAt: Date; lastSeenAt: Date | null }>(
    `SELECT bus_id AS "busId", paired_at AS "pairedAt", last_seen_at AS "lastSeenAt"
       FROM bus_devices WHERE revoked_at IS NULL ORDER BY paired_at`
  );
  response.json(trackersResponseSchema.parse({
    trackers: result.rows.map((row) => ({
      busId: row.busId,
      pairedAt: row.pairedAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null
    }))
  }));
});

trackerRoutes.post("/buses/:id/pair-code", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const busId = String(request.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(busId)) {
    response.status(400).json({ error: "Choose a valid bus." });
    return;
  }
  const member = currentMember(response);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bus = await client.query<{ label: string; active: boolean }>("SELECT label, active FROM buses WHERE id = $1 FOR UPDATE", [busId]);
    if (!bus.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Bus not found." });
      return;
    }
    if (!bus.rows[0]!.active) {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "This bus is inactive." });
      return;
    }
    // Only the newest code for a bus works.
    await client.query("UPDATE bus_pair_codes SET used_at = now() WHERE bus_id = $1 AND used_at IS NULL", [busId]);
    // Codes are unique among live codes so a code always means one bus.
    let code = "";
    for (let attempt = 0; attempt < 20 && !code; attempt += 1) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const taken = await client.query(
        "SELECT 1 FROM bus_pair_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()",
        [hashSecret(candidate)]
      );
      if (!taken.rowCount) code = candidate;
    }
    if (!code) throw new Error("Could not find a free pairing code");
    const created = await client.query<{ expiresAt: Date }>(
      `INSERT INTO bus_pair_codes (bus_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))
       RETURNING expires_at AS "expiresAt"`,
      [busId, hashSecret(code), member.id, PAIR_CODE_MINUTES]
    );
    await client.query("COMMIT");
    response.json(pairCodeResponseSchema.parse({
      code,
      expiresAt: created.rows[0]!.expiresAt.toISOString(),
      busLabel: bus.rows[0]!.label
    }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

trackerRoutes.delete("/buses/:id/tracker", requireSameOrigin, requireRole("admin", "dispatch"), async (request, response) => {
  const busId = String(request.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(busId)) {
    response.status(400).json({ error: "Choose a valid bus." });
    return;
  }
  await pool.query(
    "UPDATE bus_devices SET revoked_at = GREATEST(now(), paired_at) WHERE bus_id = $1 AND revoked_at IS NULL",
    [busId]
  );
  await pool.query("UPDATE bus_pair_codes SET used_at = now() WHERE bus_id = $1 AND used_at IS NULL", [busId]);
  response.status(204).end();
});
