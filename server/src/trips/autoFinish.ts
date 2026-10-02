import { pool } from "../db/pool.js";
import { applyTripAction } from "./actions.js";

/** A trip that reached its final stop this long ago is finished for the driver. */
export const AUTO_FINISH_AFTER_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;

type Candidate = { tripId: string; staffId: string };

/**
 * Drivers forget "Finish trip". A forgotten trip keeps the bus and driver tied
 * up, so the next trip cannot start. Finish any active trip whose final stop
 * arrival is older than the limit and whose earlier stops are all departed.
 * Trips that never reached the final stop are left alone for Dispatch.
 */
export async function finishForgottenTrips(olderThanMs = AUTO_FINISH_AFTER_MS): Promise<string[]> {
  const candidates = await pool.query<Candidate>(
    `WITH live_events AS (
       SELECT e.* FROM trip_events e
        WHERE NOT EXISTS (SELECT 1 FROM trip_events r WHERE r.replaces_event_id = e.id)
     ), final_stop AS (
       SELECT DISTINCT ON (s.trip_id) s.trip_id, s.id
         FROM trip_stops s ORDER BY s.trip_id, s.position DESC
     )
     SELECT t.id AS "tripId", a.member_id AS "staffId"
       FROM trips t
       JOIN final_stop f ON f.trip_id = t.id
       JOIN staff_assignments a ON a.trip_id = t.id AND a.ended_at IS NULL
      WHERE t.status = 'active'
        AND EXISTS (
          SELECT 1 FROM live_events e
           WHERE e.trip_id = t.id AND e.trip_stop_id = f.id AND e.event_type = 'arrived_stop'
             AND e.occurred_at <= now() - ($1::int * interval '1 millisecond'))
        AND NOT EXISTS (
          SELECT 1 FROM trip_stops s
           WHERE s.trip_id = t.id AND s.id <> f.id
             AND NOT EXISTS (SELECT 1 FROM live_events e
                              WHERE e.trip_id = t.id AND e.trip_stop_id = s.id AND e.event_type = 'departed_stop'))`,
    [olderThanMs]
  );

  const finished: string[] = [];
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const outcome = await applyTripAction(client, {
        tripId: candidate.tripId,
        actorId: candidate.staffId,
        assignedStaffMemberId: candidate.staffId,
        action: { type: "complete" },
        eventNote: "auto:finished-after-final-stop"
      });
      if (outcome.ok) {
        await client.query("COMMIT");
        finished.push(candidate.tripId);
      } else {
        await client.query("ROLLBACK");
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("Auto-finish failed for trip", candidate.tripId, error);
    } finally {
      client.release();
    }
  }
  if (finished.length) console.log(`Auto-finished ${finished.length} forgotten trip(s)`);
  return finished;
}

/** Runs the sweep every minute. Returns a stop function for shutdown. */
export function startAutoFinish(): () => void {
  const timer = setInterval(() => {
    void finishForgottenTrips().catch((error) => console.error("Auto-finish sweep failed", error));
  }, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
