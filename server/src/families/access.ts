import { CAMP_TIME_ZONE } from "@bussin/shared";
import type { PoolClient } from "pg";

/** A kid rides a trip only on their ride days (none set: every day), by the camp's calendar. */
const RIDES_THAT_DAY = `(r.ride_days IS NULL
          OR extract(isodow FROM t.departure_at AT TIME ZONE $2)::smallint = ANY (r.ride_days))`;

export async function snapshotTripRiders(client: PoolClient, tripId: string) {
  await client.query(
    `INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id)
     SELECT t.id, a.rider_id, ts.id
       FROM trips t
       JOIN rider_stop_assignments a ON a.route_id = t.route_id
       JOIN riders r ON r.id = a.rider_id
       JOIN trip_stops ts
         ON ts.trip_id = t.id
        AND ts.route_stop_id = a.route_stop_id
      WHERE t.id = $1 AND t.status = 'planned'
        AND ${RIDES_THAT_DAY}
     ON CONFLICT (trip_id, rider_id)
     DO UPDATE SET trip_stop_id = EXCLUDED.trip_stop_id`,
    [tripId, CAMP_TIME_ZONE]
  );
}

export async function syncPlannedTripRiders(client: PoolClient) {
  await client.query(
    `DELETE FROM trip_riders tr
      USING trips t
      WHERE tr.trip_id = t.id AND t.status = 'planned'`
  );

  await client.query(
    `INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id)
     SELECT t.id, a.rider_id, ts.id
       FROM trips t
       JOIN rider_stop_assignments a ON a.route_id = t.route_id
       JOIN riders r ON r.id = a.rider_id
       JOIN trip_stops ts
         ON ts.trip_id = t.id
        AND ts.route_stop_id = a.route_stop_id
      WHERE t.status = 'planned'
        AND ${RIDES_THAT_DAY.replace("$2", "$1")}
     ON CONFLICT (trip_id, rider_id)
     DO UPDATE SET trip_stop_id = EXCLUDED.trip_stop_id`,
    [CAMP_TIME_ZONE]
  );
}
