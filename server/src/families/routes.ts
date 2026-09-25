import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  familyPortalResponseSchema,
  guardianInputSchema, guardiansResponseSchema, riderInputSchema,
  rosterResponseSchema, type Guardian, type Rider
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { readSession } from "../auth/sessions.js";
import { buildDispatchEta } from "../eta/dispatchEta.js";
import { pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import { syncPlannedTripRiders } from "./access.js";
import { hashPassword } from "../auth/sessions.js";

export const familyRoutes = Router();
const idSchema = z.string().uuid();
const linksSchema = z.strictObject({ guardianIds: z.array(idSchema).max(10) }).refine(
  ({ guardianIds }) => new Set(guardianIds).size === guardianIds.length
);

type GuardianRow = Omit<Guardian, "lastSignedIn"> & { lastSignedIn: Date | null };
const guardiansSql = `SELECT g.id, g.name, g.email, g.phone,
  CASE WHEN g.member_id IS NULL THEN 'none'
       WHEN m.activated_at IS NOT NULL AND m.suspended_at IS NULL
        AND EXISTS (SELECT 1 FROM member_roles role WHERE role.member_id = m.id
                    AND role.role = 'family' AND role.revoked_at IS NULL)
       THEN 'active' ELSE 'pending' END AS "accountStatus",
  (SELECT max(s.created_at) FROM sessions s WHERE s.member_id = g.member_id) AS "lastSignedIn",
  g.import_dataset AS "importDataset"
  FROM guardians g LEFT JOIN members m ON m.id = g.member_id`;
function guardianFromRow(row: GuardianRow): Guardian {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone,
    accountStatus: row.accountStatus, importDataset: row.importDataset,
    lastSignedIn: row.lastSignedIn?.toISOString() ?? null
  };
}

type FamilyPortalRow = {
  riderId: string;
  riderName: string;
  tripId: string;
  routeName: string;
  servicePeriod: "AM" | "PM";
  busLabel: string;
  departureAt: Date;
  tripStatus: "planned" | "active";
  stopId: string;
  stopLabel: string;
  stopLatitude: number;
  stopLongitude: number;
  arrivedAt: Date | null;
  departedAt: Date | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  observedAt: Date | null;
  leaveBufferMinutes: number;
};

familyRoutes.get("/portal", requireRole("family"), async (request, response) => {
  const token = request.headers.cookie
    ?.split(/;\s*/)
    .find((part) => part.startsWith("bussin_session="))
    ?.slice("bussin_session=".length);

  const member = await readSession(token);

  if (!member) {
    response.status(401).json({ error: "Session expired." });
    return;
  }

  const result = await pool.query<FamilyPortalRow>(
    `SELECT
       rider.id AS "riderId",
       concat_ws(' ', rider.given_name, rider.family_name) AS "riderName",
       t.id AS "tripId",
       route.name AS "routeName",
       route.service_period AS "servicePeriod",
       bus.label AS "busLabel",
       t.departure_at AS "departureAt",
       t.status AS "tripStatus",
       stop.id AS "stopId",
       stop.label AS "stopLabel",
       stop.latitude::double precision AS "stopLatitude",
       stop.longitude::double precision AS "stopLongitude",
       arrived.occurred_at AS "arrivedAt",
       departed.occurred_at AS "departedAt",
       sample.latitude::double precision AS "locationLatitude",
       sample.longitude::double precision AS "locationLongitude",
       sample.observed_at AS "observedAt",
       guardian.leave_buffer_minutes::integer AS "leaveBufferMinutes"
     FROM family_trip_access access
     JOIN guardians guardian
       ON guardian.id = access.guardian_id
      AND guardian.member_id = $1
     JOIN riders rider
       ON rider.id = access.rider_id
     JOIN trips t
       ON t.id = access.trip_id
     JOIN routes route
       ON route.id = t.route_id
     JOIN buses bus
       ON bus.id = t.bus_id
     JOIN trip_stops stop
       ON stop.trip_id = t.id
      AND stop.id = access.trip_stop_id
     LEFT JOIN LATERAL (
       SELECT event.occurred_at
       FROM trip_events event
       WHERE event.trip_id = t.id
         AND event.trip_stop_id = stop.id
         AND event.event_type = 'arrived_stop'
         AND NOT EXISTS (
           SELECT 1
           FROM trip_events correction
           WHERE correction.replaces_event_id = event.id
         )
       ORDER BY event.occurred_at DESC
       LIMIT 1
     ) arrived ON true
     LEFT JOIN LATERAL (
       SELECT event.occurred_at
       FROM trip_events event
       WHERE event.trip_id = t.id
         AND event.trip_stop_id = stop.id
         AND event.event_type = 'departed_stop'
         AND NOT EXISTS (
           SELECT 1
           FROM trip_events correction
           WHERE correction.replaces_event_id = event.id
         )
       ORDER BY event.occurred_at DESC
       LIMIT 1
     ) departed ON true
     LEFT JOIN trip_current_locations current_location
       ON current_location.trip_id = t.id
     LEFT JOIN trip_location_samples sample
       ON sample.id = current_location.sample_id
     WHERE access.member_id = $1
       AND t.status IN ('planned', 'active')
     ORDER BY
       CASE WHEN t.status = 'active' THEN 0 ELSE 1 END,
       t.departure_at,
       rider.family_name,
       rider.given_name`,
    [member.id]
  );

  const etaByTrip = new Map<string, Awaited<ReturnType<typeof buildDispatchEta>>>();

  await Promise.all(
    [...new Set(
      result.rows
        .filter((row) => row.tripStatus === "active")
        .map((row) => row.tripId)
    )].map(async (tripId) => {
      etaByTrip.set(tripId, await buildDispatchEta(tripId));
    })
  );

  const rides = result.rows.map((row) => {
    const tripEta = etaByTrip.get(row.tripId) ?? null;
    const stopEta = tripEta?.stops.find((stop) => stop.stopId === row.stopId) ?? null;

    const countdownAvailable =
      row.tripStatus === "active" &&
      !row.arrivedAt &&
      !row.departedAt &&
      tripEta !== null &&
      (tripEta.status === "live" || tripEta.status === "aging") &&
      stopEta !== null &&
      !stopEta.actualArrival;

    const stopEtaAt = countdownAvailable ? stopEta.etaAt : null;
    const leaveAt = stopEtaAt
      ? new Date(
          Date.parse(stopEtaAt) - row.leaveBufferMinutes * 60_000
        ).toISOString()
      : null;

    return {
      riderId: row.riderId,
      riderName: row.riderName,
      tripId: row.tripId,
      routeName: row.routeName,
      servicePeriod: row.servicePeriod,
      busLabel: row.busLabel,
      departureAt: row.departureAt.toISOString(),
      tripStatus: row.tripStatus,
      stop: {
        id: row.stopId,
        label: row.stopLabel,
        latitude: row.stopLatitude,
        longitude: row.stopLongitude,
        arrivedAt: row.arrivedAt?.toISOString() ?? null,
        departedAt: row.departedAt?.toISOString() ?? null
      },
      location:
        row.locationLatitude !== null &&
        row.locationLongitude !== null &&
        row.observedAt
          ? {
              latitude: row.locationLatitude,
              longitude: row.locationLongitude,
              observedAt: row.observedAt.toISOString()
            }
          : null,
      eta: row.tripStatus === "active" && tripEta
        ? {
            status: tripEta.status,
            source: tripEta.source,
            stopEtaAt,
            leaveAt,
            leaveBufferMinutes: row.leaveBufferMinutes
          }
        : null
    };
  });

  response.json(familyPortalResponseSchema.parse({ rides }));
});

familyRoutes.get("/guardians", requireRole("admin"), async (_request, response) => {
  const result = await pool.query<GuardianRow>(`${guardiansSql} ORDER BY g.name, g.id`);
  response.json(guardiansResponseSchema.parse({ guardians: result.rows.map(guardianFromRow) }));
});

familyRoutes.get("/roster", requireRole("admin"), async (_request, response) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ridersResult = await client.query<{
      id: string; givenName: string; familyName: string; imported: boolean;
    }>(`SELECT id, given_name AS "givenName", family_name AS "familyName",
                import_dataset IS NOT NULL AS imported
           FROM riders ORDER BY family_name, given_name, id`);
    const stopsResult = await client.query<{
      riderId: string; direction: "AM" | "PM"; routeId: string; routeName: string;
      stopId: string; stopLabel: string;
    }>(`SELECT a.rider_id AS "riderId", a.direction, a.route_id AS "routeId",
                r.name AS "routeName", a.route_stop_id AS "stopId", s.label AS "stopLabel"
           FROM rider_stop_assignments a JOIN routes r ON r.id = a.route_id
           JOIN route_stops s ON s.route_id = a.route_id AND s.id = a.route_stop_id`);
    const guardiansResult = await client.query<GuardianRow & { riderId: string }>(
      `SELECT linked.rider_id AS "riderId", guardian.* FROM rider_guardian_links linked
        JOIN (${guardiansSql}) guardian ON guardian.id = linked.guardian_id`
    );
    await client.query("COMMIT");
    const riders = new Map<string, Rider>();
    for (const row of ridersResult.rows) riders.set(row.id, {
      ...row, am: null, pm: null, guardians: []
    });
    for (const row of stopsResult.rows) {
      const rider = riders.get(row.riderId);
      if (!rider) throw new Error("Assignment refers to missing rider");
      rider[row.direction === "AM" ? "am" : "pm"] = {
        routeId: row.routeId, routeName: row.routeName,
        stopId: row.stopId, stopLabel: row.stopLabel
      };
    }
    for (const row of guardiansResult.rows) {
      const rider = riders.get(row.riderId);
      if (!rider) throw new Error("Guardian refers to missing rider");
      rider.guardians.push(guardianFromRow(row));
    }
    response.json(rosterResponseSchema.parse({ riders: [...riders.values()] }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
});

familyRoutes.post("/guardians", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const parsed = guardianInputSchema.extend({ riderId: idSchema.nullable() }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a guardian name and optional valid email or phone." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (parsed.data.riderId) {
      const rider = await client.query(`SELECT id FROM riders WHERE id = $1 FOR UPDATE`, [parsed.data.riderId]);
      if (!rider.rowCount) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Rider not found." });
        return;
      }
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO guardians (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
      [parsed.data.name, parsed.data.email, parsed.data.phone]
    );
    if (parsed.data.riderId) await client.query(
      `INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
       VALUES ($1, $2, 'manual')`, [parsed.data.riderId, result.rows[0].id]
    );
    await client.query("COMMIT");
    response.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});


const FAMILY_TEMP_PASSWORD = "genericpassword";

familyRoutes.post("/guardians/:id/account/activate",
  requireSameOrigin, requireRole("admin"), async (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: "Invalid guardian." });
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{
        id: string;
        name: string;
        email: string | null;
        member_id: string | null;
      }>(
        `SELECT id, name, email, member_id
           FROM guardians
          WHERE id = $1
          FOR UPDATE`,
        [id.data]
      );

      const guardian = result.rows[0];

      if (!guardian) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Guardian not found." });
        return;
      }

      if (!guardian.email) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "Add an email before activating this account." });
        return;
      }

      const passwordHash = await hashPassword(FAMILY_TEMP_PASSWORD);
      let memberId = guardian.member_id;

      if (!memberId) {
        const conflict = await client.query(
          `SELECT id FROM members WHERE email = $1`,
          [guardian.email]
        );

        if (conflict.rowCount) {
          await client.query("ROLLBACK");
          response.status(409).json({
            error: "That email already belongs to another login account."
          });
          return;
        }

        const member = await client.query<{ id: string }>(
          `INSERT INTO members
             (email, display_name, password_hash, activated_at,
              suspended_at, password_change_required)
           VALUES ($1, $2, $3, now(), NULL, true)
           RETURNING id`,
          [guardian.email, guardian.name, passwordHash]
        );

        memberId = member.rows[0].id;

        await client.query(
          `UPDATE guardians SET member_id = $1 WHERE id = $2`,
          [memberId, guardian.id]
        );
      } else {
        await client.query(
          `UPDATE members
              SET password_hash = $2,
                  activated_at = COALESCE(activated_at, now()),
                  suspended_at = NULL,
                  password_change_required = true
            WHERE id = $1`,
          [memberId, passwordHash]
        );
      }

      await client.query(
        `INSERT INTO member_roles (member_id, role)
         VALUES ($1, 'family')
         ON CONFLICT (member_id, role)
         DO UPDATE SET revoked_at = NULL`,
        [memberId]
      );

      await client.query(
        `UPDATE sessions
            SET revoked_at = now()
          WHERE member_id = $1
            AND revoked_at IS NULL`,
        [memberId]
      );

      await client.query("COMMIT");

      response.json({
        status: "active",
        temporaryPassword: FAMILY_TEMP_PASSWORD
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
);

familyRoutes.post("/guardians/:id/account/deactivate",
  requireSameOrigin, requireRole("admin"), async (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: "Invalid guardian." });
      return;
    }

    const result = await pool.query<{ memberId: string }>(
      `UPDATE members m
          SET suspended_at = now()
         FROM guardians g
        WHERE g.id = $1
          AND g.member_id = m.id
      RETURNING m.id AS "memberId"`,
      [id.data]
    );

    const member = result.rows[0];

    if (!member) {
      response.status(409).json({ error: "Guardian does not have a login account." });
      return;
    }

    await pool.query(
      `UPDATE sessions
          SET revoked_at = now()
        WHERE member_id = $1
          AND revoked_at IS NULL`,
      [member.memberId]
    );

    response.json({ status: "deactivated" });
  }
);

familyRoutes.post("/guardians/:id/account/reset-password",
  requireSameOrigin, requireRole("admin"), async (request, response) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: "Invalid guardian." });
      return;
    }

    const passwordHash = await hashPassword(FAMILY_TEMP_PASSWORD);

    const result = await pool.query<{ memberId: string }>(
      `UPDATE members m
          SET password_hash = $2,
              password_change_required = true
         FROM guardians g
        WHERE g.id = $1
          AND g.member_id = m.id
      RETURNING m.id AS "memberId"`,
      [id.data, passwordHash]
    );

    const member = result.rows[0];

    if (!member) {
      response.status(409).json({ error: "Guardian does not have a login account." });
      return;
    }

    await pool.query(
      `UPDATE sessions
          SET revoked_at = now()
        WHERE member_id = $1
          AND revoked_at IS NULL`,
      [member.memberId]
    );

    response.json({
      status: "password-reset",
      temporaryPassword: FAMILY_TEMP_PASSWORD
    });
  }
);

familyRoutes.put("/guardians/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const parsed = guardianInputSchema.safeParse(request.body);
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Enter a guardian name and optional valid email or phone." });
    return;
  }
  const result = await pool.query<{ id: string }>(
    `UPDATE guardians SET name = $2, email = $3, phone = $4 WHERE id = $1 RETURNING id`,
    [id.data, parsed.data.name, parsed.data.email, parsed.data.phone]
  );
  if (!result.rowCount) {
    response.status(404).json({ error: "Guardian not found." });
    return;
  }
  response.json(result.rows[0]);
});

async function saveManualLinks(client: PoolClient, riderId: string, guardianIds: string[]) {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM guardians WHERE id = ANY($1::uuid[]) FOR SHARE`, [guardianIds]
  );
  if (result.rowCount !== guardianIds.length) return false;
  await client.query(
    `DELETE FROM rider_guardian_links WHERE rider_id = $1 AND source = 'manual'
       AND NOT (guardian_id = ANY($2::uuid[]))`, [riderId, guardianIds]
  );
  for (const guardianId of guardianIds) {
    await client.query(
      `INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
       VALUES ($1, $2, 'manual') ON CONFLICT (rider_id, guardian_id) DO NOTHING`,
      [riderId, guardianId]
    );
  }
  return true;
}

familyRoutes.put("/riders/:id/guardians", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  const parsed = linksSchema.safeParse(request.body);
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Choose up to ten distinct guardian contacts." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rider = await client.query(`SELECT id FROM riders WHERE id = $1 FOR UPDATE`, [id.data]);
    if (!rider.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "Rider not found." });
      return;
    }
    if (!(await saveManualLinks(client, id.data, parsed.data.guardianIds))) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: "Choose existing guardians." });
      return;
    }
    await client.query("COMMIT");
    response.json({ id: id.data });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

type RiderInput = ReturnType<typeof riderInputSchema.parse>;
async function validStops(client: PoolClient, data: RiderInput, riderId?: string) {
  for (const [direction, assigned] of [["AM", data.am], ["PM", data.pm]] as const) {
    if (!assigned) continue;
    const stop = await client.query(
      `SELECT 1 FROM route_stops s JOIN routes r ON r.id = s.route_id
       WHERE s.route_id = $1 AND s.id = $2 AND r.service_period = $4
         AND (r.active OR EXISTS (
         SELECT 1 FROM rider_stop_assignments old WHERE old.rider_id = $3
         AND old.direction = $4 AND old.route_id = s.route_id AND old.route_stop_id = s.id
       )) FOR SHARE OF s, r`,
      [assigned.routeId, assigned.stopId, riderId ?? null, direction]
    );
    if (!stop.rowCount) return false;
  }
  return true;
}

async function writeRider(request: Request, response: Response, id?: string) {
  const parsed = riderInputSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Enter a rider, guardians, and valid assigned stops." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (id) {
      const existing = await client.query<{ import_dataset: string | null }>(
        `SELECT import_dataset FROM riders WHERE id = $1 FOR UPDATE`, [id]);
      if (!existing.rowCount) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Rider not found." });
        return;
      }
      if (existing.rows[0].import_dataset !== null) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Update imported stops and names in the roster file." });
        return;
      }
    }
    if (!(await validStops(client, parsed.data, id))) {
      await client.query("ROLLBACK");
      response.status(409).json({
        error: "Choose AM stops on AM routes and PM stops on PM routes."
      });
      return;
    }
    const rider = id
      ? await client.query<{ id: string }>(
          `UPDATE riders SET given_name = $2, family_name = $3 WHERE id = $1 RETURNING id`,
          [id, parsed.data.givenName, parsed.data.familyName])
      : await client.query<{ id: string }>(
          `INSERT INTO riders (given_name, family_name) VALUES ($1, $2) RETURNING id`,
          [parsed.data.givenName, parsed.data.familyName]);
    const riderId = rider.rows[0].id;
    if (!(await saveManualLinks(client, riderId, parsed.data.guardianIds))) {
      await client.query("ROLLBACK");
      response.status(400).json({ error: "Choose existing guardians." });
      return;
    }
    await client.query(`DELETE FROM rider_stop_assignments WHERE rider_id = $1`, [riderId]);
    for (const [direction, stop] of [["AM", parsed.data.am], ["PM", parsed.data.pm]] as const) {
      if (!stop) continue;
      await client.query(
        `INSERT INTO rider_stop_assignments (rider_id, direction, route_id, route_stop_id)
         VALUES ($1, $2, $3, $4)`, [riderId, direction, stop.routeId, stop.stopId]
      );
    }
    await syncPlannedTripRiders(client);
    await client.query("COMMIT");
    response.status(id ? 200 : 201).json({ id: riderId });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

familyRoutes.post("/riders", requireSameOrigin, requireRole("admin"),
  async (request, response) => writeRider(request, response));
familyRoutes.put("/riders/:id", requireSameOrigin, requireRole("admin"), async (request, response) => {
  const id = idSchema.safeParse(request.params.id);
  if (!id.success) {
    response.status(400).json({ error: "Invalid rider ID." });
    return;
  }
  await writeRider(request, response, id.data);
});
