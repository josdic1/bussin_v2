CREATE TABLE trip_location_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  member_id uuid NOT NULL REFERENCES members(id),
  client_sample_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m numeric(8,2) NOT NULL CHECK (accuracy_m > 0 AND accuracy_m <= 10000),
  speed_mps numeric(8,2) CHECK (speed_mps >= 0 AND speed_mps <= 200),
  heading_degrees numeric(5,2)
    CHECK (heading_degrees >= 0 AND heading_degrees < 360),
  UNIQUE (trip_id, client_sample_id),
  UNIQUE (id, trip_id),
  CHECK (observed_at <= received_at + interval '1 minute')
);

CREATE INDEX trip_location_samples_history_idx
  ON trip_location_samples (trip_id, observed_at DESC);

CREATE TABLE trip_current_locations (
  trip_id uuid PRIMARY KEY REFERENCES trips(id),
  sample_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (sample_id, trip_id)
    REFERENCES trip_location_samples(id, trip_id)
);

CREATE TABLE trip_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'started', 'arrived_stop', 'departed_stop',
      'completed', 'cancelled', 'correction', 'note'
    )
  ),
  trip_stop_id uuid,
  recorded_by uuid NOT NULL REFERENCES members(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  note text,
  replaces_event_id uuid,
  UNIQUE (id, trip_id),
  FOREIGN KEY (trip_id, trip_stop_id)
    REFERENCES trip_stops(trip_id, id),
  FOREIGN KEY (replaces_event_id, trip_id)
    REFERENCES trip_events(id, trip_id),
  CHECK (
    event_type NOT IN ('arrived_stop', 'departed_stop')
    OR trip_stop_id IS NOT NULL
  ),
  CHECK (
    (event_type = 'correction') = (replaces_event_id IS NOT NULL)
  )
);

CREATE INDEX trip_events_timeline_idx
  ON trip_events (trip_id, occurred_at, recorded_at);

CREATE FUNCTION accept_trip_location_sample()
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

CREATE TRIGGER accept_trip_location_sample
BEFORE INSERT ON trip_location_samples
FOR EACH ROW EXECUTE FUNCTION accept_trip_location_sample();

CREATE FUNCTION update_trip_current_location()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO trip_current_locations (trip_id, sample_id, observed_at)
  VALUES (NEW.trip_id, NEW.id, NEW.observed_at)
  ON CONFLICT (trip_id) DO UPDATE
    SET sample_id = EXCLUDED.sample_id,
        observed_at = EXCLUDED.observed_at
    WHERE trip_current_locations.observed_at < EXCLUDED.observed_at;

  RETURN NEW;
END;
$$;

CREATE TRIGGER update_trip_current_location
AFTER INSERT ON trip_location_samples
FOR EACH ROW EXECUTE FUNCTION update_trip_current_location();

CREATE FUNCTION deny_trip_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Trip history is append-only';
END;
$$;

CREATE TRIGGER deny_trip_location_mutation
BEFORE UPDATE OR DELETE ON trip_location_samples
FOR EACH ROW EXECUTE FUNCTION deny_trip_history_mutation();

CREATE TRIGGER deny_trip_event_mutation
BEFORE UPDATE OR DELETE ON trip_events
FOR EACH ROW EXECUTE FUNCTION deny_trip_history_mutation();
