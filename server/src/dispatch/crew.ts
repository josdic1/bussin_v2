import type { PoolClient } from "pg";
import type { AssignTripCrew, TripDriver, TripStaff } from "@bussin/shared";
import { pool } from "../db/pool.js";

// Trip crew: one driver (a name, not a login), a lead counselor, and up to 3 more
// counselors. The database enforces the limits (migration 033); this file reads
// the crew for the board and saves a whole crew in one transaction.

export type Crew = { driver: TripDriver | null; counselors: TripStaff[] };

/** Driver and extra counselors for each trip. The lead stays in assignedStaff. */
export async function loadCrew(tripIds: string[]): Promise<Map<string, Crew>> {
  const crew = new Map<string, Crew>(tripIds.map((id) => [id, { driver: null, counselors: [] }]));
  if (!tripIds.length) return crew;

  // The open driver; for a finished trip, whoever was driving at the end.
  const drivers = await pool.query<{ tripId: string; id: string; name: string; phone: string | null }>(
    `SELECT DISTINCT ON (a.trip_id) a.trip_id AS "tripId", d.id, d.name, d.phone
       FROM trip_driver_assignments a JOIN drivers d ON d.id = a.driver_id
      WHERE a.trip_id = ANY($1::uuid[])
      ORDER BY a.trip_id, (a.ended_at IS NULL) DESC, a.assigned_at DESC, a.id DESC`,
    [tripIds]
  );
  for (const row of drivers.rows) crew.get(row.tripId)!.driver = { id: row.id, name: row.name, phone: row.phone };

  // Extra counselors: open seats, or for a finished trip, the ones still on it when it ended.
  const counselors = await pool.query<{ tripId: string; id: string; displayName: string }>(
    `SELECT a.trip_id AS "tripId", m.id, m.display_name AS "displayName"
       FROM staff_assignments a
       JOIN members m ON m.id = a.member_id
       JOIN trips t ON t.id = a.trip_id
      WHERE a.trip_id = ANY($1::uuid[])
        AND a.crew_role = 'counselor'
        AND (a.ended_at IS NULL OR a.ended_at >= COALESCE(t.ended_at, t.cancelled_at))
      ORDER BY a.trip_id, a.assigned_at, m.display_name`,
    [tripIds]
  );
  for (const row of counselors.rows) crew.get(row.tripId)!.counselors.push({ id: row.id, displayName: row.displayName });
  return crew;
}

/** A refusal shown to the dispatcher as-is. */
export class CrewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * Save the whole crew for a trip. Planned trips: anything can change.
 * Running trips: only the driver (a mid-route swap); lead and counselors are fixed.
 * Swaps end the old row and open a new one, so history is kept.
 */
export async function saveCrew(client: PoolClient, tripId: string, want: AssignTripCrew): Promise<void> {
  const trip = await client.query<{ status: string }>("SELECT status FROM trips WHERE id = $1 FOR UPDATE", [tripId]);
  if (!trip.rowCount) throw new CrewError(404, "Trip not found.");
  const status = trip.rows[0]!.status;
  if (status !== "planned" && status !== "active") throw new CrewError(409, "This trip is over. Its crew can't change.");

  const seats = await client.query<{ id: string; memberId: string; role: "lead" | "counselor" }>(
    `SELECT id, member_id AS "memberId", crew_role AS role FROM staff_assignments
      WHERE trip_id = $1 AND ended_at IS NULL FOR UPDATE`,
    [tripId]
  );
  const wantSeats = new Map<string, "lead" | "counselor">();
  if (want.leadId) wantSeats.set(want.leadId, "lead");
  for (const id of want.counselorIds) wantSeats.set(id, "counselor");

  const same = seats.rows.length === wantSeats.size && seats.rows.every((s) => wantSeats.get(s.memberId) === s.role);
  if (!same) {
    if (status !== "planned") {
      throw new CrewError(409, "Counselors can only change before the trip starts. The driver can still be swapped.");
    }
    // Everyone must be active staff.
    if (wantSeats.size) {
      const ok = await client.query<{ id: string }>(
        `SELECT m.id FROM members m
           JOIN member_roles r ON r.member_id = m.id AND r.role = 'staff' AND r.revoked_at IS NULL
          WHERE m.id = ANY($1::uuid[]) AND m.suspended_at IS NULL`,
        [[...wantSeats.keys()]]
      );
      if (ok.rowCount !== wantSeats.size) throw new CrewError(409, "Pick active staff for the lead and counselors.");
    }
    // End seats that go away or change role first, then open the new ones.
    const keep = new Set<string>();
    for (const seat of seats.rows) {
      if (wantSeats.get(seat.memberId) === seat.role) keep.add(seat.memberId);
      else await client.query(`UPDATE staff_assignments SET ended_at = GREATEST(now(), assigned_at) WHERE id = $1`, [seat.id]);
    }
    for (const [memberId, role] of wantSeats) {
      if (keep.has(memberId)) continue;
      await client.query(
        `INSERT INTO staff_assignments (trip_id, member_id, crew_role) VALUES ($1, $2, $3)`,
        [tripId, memberId, role]
      );
    }
  }

  // Driver: swap only if it changed.
  const driver = await client.query<{ id: string; driverId: string }>(
    `SELECT id, driver_id AS "driverId" FROM trip_driver_assignments
      WHERE trip_id = $1 AND ended_at IS NULL FOR UPDATE`,
    [tripId]
  );
  const current = driver.rows[0]?.driverId ?? null;
  if (current !== want.driverId) {
    if (want.driverId) {
      const active = await client.query(`SELECT 1 FROM drivers WHERE id = $1 AND active`, [want.driverId]);
      if (!active.rowCount) throw new CrewError(409, "Pick an active driver.");
    }
    if (driver.rows[0]) {
      await client.query(`UPDATE trip_driver_assignments SET ended_at = GREATEST(now(), assigned_at) WHERE id = $1`, [driver.rows[0].id]);
    }
    if (want.driverId) {
      await client.query(`INSERT INTO trip_driver_assignments (trip_id, driver_id) VALUES ($1, $2)`, [tripId, want.driverId]);
    }
  }
}
