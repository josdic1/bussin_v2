-- Trips are the canonical operational record. Every scheduled run in the
-- current product already has exactly one trip, so keep the departure on the
-- trip instead of maintaining a second lifecycle record.

ALTER TABLE trips ADD COLUMN departure_at timestamptz;

UPDATE trips t
   SET departure_at = sr.departure_at
  FROM scheduled_runs sr
 WHERE sr.id = t.scheduled_run_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM scheduled_runs sr
      LEFT JOIN trips t ON t.scheduled_run_id = sr.id
     WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot remove scheduled_runs: at least one scheduled run has no trip';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM scheduled_runs sr
      JOIN trips t ON t.scheduled_run_id = sr.id
     WHERE sr.planned_staff_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot remove scheduled_runs: planned_staff_id contains data that needs an explicit migration';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM scheduled_runs sr
      JOIN trips t ON t.scheduled_run_id = sr.id
     WHERE sr.cancelled_at IS NOT NULL
       AND (t.status <> 'cancelled' OR t.cancelled_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot remove scheduled_runs: cancellation state disagrees with trips';
  END IF;

  IF EXISTS (SELECT 1 FROM trips WHERE departure_at IS NULL) THEN
    RAISE EXCEPTION 'Cannot make trips canonical: at least one trip has no scheduled departure';
  END IF;
END $$;

ALTER TABLE trips ALTER COLUMN departure_at SET NOT NULL;
CREATE INDEX trips_departure_idx ON trips (departure_at);

ALTER TABLE trips DROP COLUMN scheduled_run_id;
DROP TABLE scheduled_runs;
