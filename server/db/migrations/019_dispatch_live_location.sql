-- Publish canonical current-location changes so every server instance can push
-- them to its connected Dispatch browsers without polling PostgreSQL per browser.
CREATE OR REPLACE FUNCTION notify_dispatch_live_location()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payload text;
BEGIN
  SELECT json_build_object(
           'tripId', sample.trip_id,
           'location', json_build_object(
             'latitude', sample.latitude::double precision,
             'longitude', sample.longitude::double precision,
             'observedAt', sample.observed_at,
             'accuracyM', sample.accuracy_m::double precision
           )
         )::text
    INTO payload
    FROM trip_location_samples sample
   WHERE sample.id = NEW.sample_id;

  IF payload IS NOT NULL THEN
    PERFORM pg_notify('bussin_dispatch_location', payload);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_dispatch_live_location ON trip_current_locations;
CREATE TRIGGER notify_dispatch_live_location
AFTER INSERT OR UPDATE OF sample_id ON trip_current_locations
FOR EACH ROW EXECUTE FUNCTION notify_dispatch_live_location();
