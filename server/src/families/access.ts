import type { PoolClient } from "pg";

export async function snapshotTripRiders(client: PoolClient, tripId: string) {
  await client.query(
    `INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id)
     SELECT t.id, a.rider_id, ts.id
       FROM trips t
       JOIN rider_stop_assignments a ON a.route_id = t.route_id
       JOIN trip_stops ts
         ON ts.trip_id = t.id
        AND ts.route_stop_id = a.route_stop_id
      WHERE t.id = $1 AND t.status = 'planned'
     ON CONFLICT (trip_id, rider_id)
     DO UPDATE SET trip_stop_id = EXCLUDED.trip_stop_id`,
    [tripId]
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
       JOIN trip_stops ts
         ON ts.trip_id = t.id
        AND ts.route_stop_id = a.route_stop_id
      WHERE t.status = 'planned'`
  );
}
