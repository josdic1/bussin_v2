import { Router, type Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  bulkCheckActionSchema,
  checkBoardResponseSchema,
  riderCheckActionSchema,
  type CheckEvent,
  type RiderCheckEventType
} from "@bussin/shared";
import { requireRole, requireSameOrigin } from "../auth/guard.js";
import { readSession } from "../auth/sessions.js";
import { pool } from "../db/pool.js";
import {
  checkTransition,
  deriveRiderState,
  type RiderEventRow,
  type TripStatus
} from "./state.js";

export const checkRoutes = Router();

const uuidSchema = z.string().uuid();
const boardQuerySchema = z.strictObject({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true })
});

function sessionToken(request: Request) {
  return request.headers.cookie?.split(/;\s*/)
    .find((part) => part.startsWith("bussin_session="))
    ?.slice("bussin_session=".length);
}

type TripRow = {
  id: string;
  busId: string;
  busLabel: string;
  routeName: string;
  servicePeriod: "AM" | "PM";
  departureAt: Date;
  status: TripStatus;
  staffId: string | null;
  staffName: string | null;
  staffLastSeenAt: Date | null;
  sweepAt: Date | null;
  sweepBy: string | null;
};

type StopRow = {
  tripId: string;
  id: string;
  position: number;
  label: string;
  arrivedAt: Date | null;
  departedAt: Date | null;
};

type RiderRow = {
  tripId: string;
  riderId: string;
  givenName: string;
  familyName: string;
  stopId: string;
};

type GuardianRow = {
  riderId: string;
  name: string;
  phone: string | null;
};

type EventRow = {
  id: string;
  tripId: string;
  riderId: string;
  eventType: RiderCheckEventType;
  occurredAt: Date;
  recordedByName: string;
};

checkRoutes.get("/board", requireRole("admin", "dispatch"), async (request, response) => {
  const parsed = boardQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: "Choose a valid day." });
    return;
  }
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > 48 * 60 * 60 * 1000) {
    response.status(400).json({ error: "Choose a single day." });
    return;
  }

  const trips = await pool.query<TripRow>(
    `SELECT t.id, t.bus_id AS "busId", b.label AS "busLabel",
            r.name AS "routeName", r.service_period AS "servicePeriod",
            t.departure_at AS "departureAt", t.status,
            staff.id AS "staffId", staff.display_name AS "staffName",
            presence.last_seen_at AS "staffLastSeenAt",
            sweep.occurred_at AS "sweepAt", sweeper.display_name AS "sweepBy"
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN LATERAL (
         SELECT m.id, m.display_name
           FROM staff_assignments a
           JOIN members m ON m.id = a.member_id
          WHERE a.trip_id = t.id
          ORDER BY (a.ended_at IS NULL) DESC, a.assigned_at DESC, a.id DESC
          LIMIT 1
       ) staff ON true
       LEFT JOIN staff_presence presence ON presence.member_id = staff.id
       LEFT JOIN trip_sweeps sweep ON sweep.trip_id = t.id
       LEFT JOIN members sweeper ON sweeper.id = sweep.recorded_by
      WHERE (t.departure_at >= $1 AND t.departure_at < $2) OR t.status = 'active'
      ORDER BY t.departure_at, t.id
      LIMIT 100`,
    [from, to]
  );

  const ids = trips.rows.map((trip) => trip.id);
  if (!ids.length) {
    response.json(checkBoardResponseSchema.parse({ trips: [] }));
    return;
  }

  const [stops, riders, guardians, events] = await Promise.all([
    pool.query<StopRow>(
      `SELECT s.trip_id AS "tripId", s.id, s.position, s.label,
              (SELECT e.occurred_at FROM trip_events e
                WHERE e.trip_id = s.trip_id AND e.trip_stop_id = s.id
                  AND e.event_type = 'arrived_stop'
                  AND NOT EXISTS (SELECT 1 FROM trip_events c WHERE c.replaces_event_id = e.id)
                ORDER BY e.occurred_at DESC LIMIT 1) AS "arrivedAt",
              (SELECT e.occurred_at FROM trip_events e
                WHERE e.trip_id = s.trip_id AND e.trip_stop_id = s.id
                  AND e.event_type = 'departed_stop'
                  AND NOT EXISTS (SELECT 1 FROM trip_events c WHERE c.replaces_event_id = e.id)
                ORDER BY e.occurred_at DESC LIMIT 1) AS "departedAt"
         FROM trip_stops s
        WHERE s.trip_id = ANY($1::uuid[])
        ORDER BY s.trip_id, s.position`,
      [ids]
    ),
    pool.query<RiderRow>(
      `SELECT tr.trip_id AS "tripId", tr.rider_id AS "riderId",
              r.given_name AS "givenName", r.family_name AS "familyName",
              tr.trip_stop_id AS "stopId"
         FROM trip_riders tr
         JOIN riders r ON r.id = tr.rider_id
        WHERE tr.trip_id = ANY($1::uuid[])
        ORDER BY r.family_name, r.given_name, r.id`,
      [ids]
    ),
    pool.query<GuardianRow>(
      `SELECT DISTINCT ON (l.rider_id, g.id) l.rider_id AS "riderId", g.name, g.phone
         FROM rider_guardian_links l
         JOIN guardians g ON g.id = l.guardian_id
        WHERE l.rider_id IN (SELECT rider_id FROM trip_riders WHERE trip_id = ANY($1::uuid[]))
        ORDER BY l.rider_id, g.id`,
      [ids]
    ),
    pool.query<EventRow>(
      `SELECT e.id, e.trip_id AS "tripId", e.rider_id AS "riderId",
              e.event_type AS "eventType", e.occurred_at AS "occurredAt",
              m.display_name AS "recordedByName"
         FROM trip_rider_events e
         JOIN members m ON m.id = e.recorded_by
        WHERE e.trip_id = ANY($1::uuid[])
        ORDER BY e.occurred_at, e.recorded_at, e.id`,
      [ids]
    )
  ]);

  const guardiansByRider = new Map<string, { name: string; phone: string | null }[]>();
  for (const row of guardians.rows) {
    const list = guardiansByRider.get(row.riderId) ?? [];
    list.push({ name: row.name, phone: row.phone });
    guardiansByRider.set(row.riderId, list);
  }

  const result = trips.rows.map((trip) => {
    const tripEvents = events.rows.filter((event) => event.tripId === trip.id);
    const tripRiders = riders.rows.filter((rider) => rider.tripId === trip.id);
    const names = new Map(tripRiders.map((rider) =>
      [rider.riderId, `${rider.givenName} ${rider.familyName}`]));

    const log: CheckEvent[] = tripEvents.map((event) => ({
      id: event.id,
      riderId: event.riderId,
      riderName: names.get(event.riderId) ?? null,
      kind: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      recordedBy: event.recordedByName
    }));
    if (trip.sweepAt && trip.sweepBy) {
      log.push({
        id: trip.id,
        riderId: null,
        riderName: null,
        kind: "bus_checked_empty",
        occurredAt: trip.sweepAt.toISOString(),
        recordedBy: trip.sweepBy
      });
    }
    log.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

    return {
      id: trip.id,
      busId: trip.busId,
      busLabel: trip.busLabel,
      routeName: trip.routeName,
      servicePeriod: trip.servicePeriod,
      departureAt: trip.departureAt.toISOString(),
      status: trip.status,
      assignedStaff: trip.staffId && trip.staffName
        ? { id: trip.staffId, displayName: trip.staffName }
        : null,
      staffLastSeenAt: trip.staffLastSeenAt?.toISOString() ?? null,
      stops: stops.rows.filter((stop) => stop.tripId === trip.id).map((stop) => ({
        id: stop.id,
        position: stop.position,
        label: stop.label,
        arrivedAt: stop.arrivedAt?.toISOString() ?? null,
        departedAt: stop.departedAt?.toISOString() ?? null
      })),
      sweep: trip.sweepAt && trip.sweepBy
        ? { confirmedAt: trip.sweepAt.toISOString(), confirmedBy: trip.sweepBy }
        : null,
      riders: tripRiders.map((rider) => {
        const derived = deriveRiderState(
          tripEvents.filter((event) => event.riderId === rider.riderId)
        );
        return {
          riderId: rider.riderId,
          givenName: rider.givenName,
          familyName: rider.familyName,
          stopId: rider.stopId,
          state: derived.state,
          stateAt: derived.stateAt?.toISOString() ?? null,
          stateBy: derived.stateBy,
          boardedAt: derived.boardedAt?.toISOString() ?? null,
          handled: derived.handled,
          guardians: guardiansByRider.get(rider.riderId) ?? []
        };
      }),
      events: log
    };
  });

  response.json(checkBoardResponseSchema.parse({ trips: result }));
});

async function lockTrip(client: PoolClient, tripId: string) {
  const trip = await client.query<{ status: TripStatus }>(
    "SELECT status FROM trips WHERE id = $1 FOR UPDATE",
    [tripId]
  );
  return trip.rows[0]?.status ?? null;
}

async function riderEvents(client: PoolClient, tripId: string, riderId: string) {
  const rows = await client.query<RiderEventRow>(
    `SELECT e.event_type AS "eventType", e.occurred_at AS "occurredAt",
            m.display_name AS "recordedByName"
       FROM trip_rider_events e
       JOIN members m ON m.id = e.recorded_by
      WHERE e.trip_id = $1 AND e.rider_id = $2
      ORDER BY e.occurred_at, e.recorded_at, e.id`,
    [tripId, riderId]
  );
  return rows.rows;
}

checkRoutes.post(
  "/trips/:tripId/riders/:riderId",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const tripId = uuidSchema.safeParse(request.params.tripId);
    const riderId = uuidSchema.safeParse(request.params.riderId);
    const action = riderCheckActionSchema.safeParse(request.body);
    if (!tripId.success || !riderId.success || !action.success) {
      response.status(400).json({ error: "Choose a valid rider check." });
      return;
    }
    const actor = await readSession(sessionToken(request));
    if (!actor) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const status = await lockTrip(client, tripId.data);
      if (!status) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Trip not found." });
        return;
      }
      const onTrip = await client.query(
        "SELECT 1 FROM trip_riders WHERE trip_id = $1 AND rider_id = $2",
        [tripId.data, riderId.data]
      );
      if (!onTrip.rowCount) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "That rider is not on this trip." });
        return;
      }

      const current = deriveRiderState(await riderEvents(client, tripId.data, riderId.data));
      const transition = checkTransition(current, action.data.type, status);
      if (!transition.ok) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: transition.error });
        return;
      }

      await client.query(
        `INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by)
         VALUES ($1, $2, $3, $4)`,
        [tripId.data, riderId.data, transition.eventType, actor.id]
      );
      await client.query("COMMIT");
      const next = deriveRiderState([
        ...await riderEvents(client, tripId.data, riderId.data)
      ]);
      response.json({ state: next.state, handled: next.handled });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
);

checkRoutes.post(
  "/trips/:tripId/bulk",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const tripId = uuidSchema.safeParse(request.params.tripId);
    const action = bulkCheckActionSchema.safeParse(request.body);
    if (!tripId.success || !action.success) {
      response.status(400).json({ error: "Choose a valid check." });
      return;
    }
    const actor = await readSession(sessionToken(request));
    if (!actor) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const status = await lockTrip(client, tripId.data);
      if (!status) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Trip not found." });
        return;
      }
      const riders = await client.query<{ riderId: string }>(
        `SELECT rider_id AS "riderId" FROM trip_riders WHERE trip_id = $1`,
        [tripId.data]
      );
      const wanted = action.data.type === "board_waiting" ? "expected" : "aboard";
      const single = action.data.type === "board_waiting" ? "board" : "drop";
      let changed = 0;
      for (const rider of riders.rows) {
        const current = deriveRiderState(await riderEvents(client, tripId.data, rider.riderId));
        if (current.state !== wanted) continue;
        const transition = checkTransition(current, single, status);
        if (!transition.ok) {
          await client.query("ROLLBACK");
          response.status(409).json({ error: transition.error });
          return;
        }
        await client.query(
          `INSERT INTO trip_rider_events (trip_id, rider_id, event_type, recorded_by)
           VALUES ($1, $2, $3, $4)`,
          [tripId.data, rider.riderId, transition.eventType, actor.id]
        );
        changed += 1;
      }
      await client.query("COMMIT");
      response.json({ changed });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
);

checkRoutes.post(
  "/trips/:tripId/sweep",
  requireSameOrigin,
  requireRole("admin", "dispatch"),
  async (request, response) => {
    const tripId = uuidSchema.safeParse(request.params.tripId);
    if (!tripId.success) {
      response.status(400).json({ error: "Choose a valid trip." });
      return;
    }
    const actor = await readSession(sessionToken(request));
    if (!actor) {
      response.status(401).json({ error: "Session expired." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const status = await lockTrip(client, tripId.data);
      if (!status) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "Trip not found." });
        return;
      }
      if (status !== "active" && status !== "completed") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Only a running or completed trip can be checked empty." });
        return;
      }
      const already = await client.query("SELECT 1 FROM trip_sweeps WHERE trip_id = $1", [tripId.data]);
      if (already.rowCount) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "The bus was already checked empty." });
        return;
      }
      const riders = await client.query<{ riderId: string }>(
        `SELECT rider_id AS "riderId" FROM trip_riders WHERE trip_id = $1`,
        [tripId.data]
      );
      for (const rider of riders.rows) {
        const current = deriveRiderState(await riderEvents(client, tripId.data, rider.riderId));
        if (current.state === "aboard") {
          await client.query("ROLLBACK");
          response.status(409).json({ error: "Riders are still marked aboard. Resolve them first." });
          return;
        }
      }
      await client.query(
        "INSERT INTO trip_sweeps (trip_id, recorded_by) VALUES ($1, $2)",
        [tripId.data, actor.id]
      );
      await client.query("COMMIT");
      response.json({ swept: true });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
);
