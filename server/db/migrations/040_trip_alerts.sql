-- Counselor updates and emergencies, sent from the phone on a trip.
-- kind 'update': running late, traffic, bathroom stop, and so on. kind 'emergency': accident,
-- medical, breakdown. Dispatch marks each one handled; the crew's phones see that it was seen.
CREATE TABLE trip_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  kind text NOT NULL CHECK (kind IN ('update', 'emergency')),
  code text NOT NULL CHECK (code ~ '^[a-z_0-9]{1,40}$'),
  note text CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 300),
  latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  recorded_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES members(id),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX trip_alerts_trip_idx ON trip_alerts (trip_id, created_at);
CREATE INDEX trip_alerts_open_idx ON trip_alerts (created_at DESC) WHERE resolved_at IS NULL;

-- Dispatch hears every new or handled alert at once.
CREATE FUNCTION notify_trip_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('bussin_dispatch_alert', json_build_object('id', NEW.id, 'tripId', NEW.trip_id)::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_trip_alert
AFTER INSERT OR UPDATE ON trip_alerts
FOR EACH ROW EXECUTE FUNCTION notify_trip_alert();

-- The crew's phones hear it too, so the sender sees "Dispatch saw it".
CREATE TRIGGER notify_staff_trip_alert
AFTER INSERT OR UPDATE ON trip_alerts
FOR EACH ROW EXECUTE FUNCTION notify_staff_trip_change();
