-- Dead zones: a phone that loses signal keeps its GPS fixes and sends them when
-- signal returns. Accept fixes up to 15 minutes old (was 60 seconds) so an
-- arrival or departure that happened in a dead zone is still recorded.
CREATE OR REPLACE FUNCTION accept_trip_location_sample()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  trip_started_at timestamptz;
  trip_status text;
BEGIN
  SELECT status, started_at
    INTO trip_status, trip_started_at
    FROM trips
   WHERE id = NEW.trip_id
   FOR UPDATE;

  IF trip_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'GPS samples require an active trip';
  END IF;

  IF NEW.observed_at < trip_started_at - interval '1 minute' THEN
    RAISE EXCEPTION 'GPS sample predates trip start';
  END IF;

  IF NEW.observed_at < clock_timestamp() - interval '15 minutes' THEN
    RAISE EXCEPTION 'GPS sample is stale';
  END IF;

  IF NEW.observed_at > clock_timestamp() + interval '30 seconds' THEN
    RAISE EXCEPTION 'GPS sample is too far in the future';
  END IF;

  IF NEW.accuracy_m > 100 THEN
    RAISE EXCEPTION 'GPS sample accuracy is too poor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM staff_assignments
     WHERE trip_id = NEW.trip_id
       AND member_id = NEW.member_id
       AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'GPS sender is not assigned to this trip';
  END IF;

  RETURN NEW;
END;
$$;
