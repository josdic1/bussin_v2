-- Bus trackers: a phone mounted on a bus that signs in as the bus, not a person.
--
-- Pairing: Dispatch makes a short code for a bus (good for 15 minutes, used once).
-- The phone enters it at /bus and gets a long-lived device cookie. From then on it
-- follows whatever trip its bus is running and is that bus's GPS source.
-- One paired phone per bus; pairing a new one retires the old one.

CREATE TABLE bus_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_id uuid NOT NULL REFERENCES buses(id),
  token_hash bytea NOT NULL UNIQUE,
  paired_at timestamptz NOT NULL DEFAULT now(),
  paired_by uuid REFERENCES members(id),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at >= paired_at)
);

CREATE UNIQUE INDEX one_active_device_per_bus
  ON bus_devices (bus_id) WHERE revoked_at IS NULL;

CREATE TABLE bus_pair_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bus_id uuid NOT NULL REFERENCES buses(id),
  code_hash bytea NOT NULL,
  created_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX bus_pair_codes_lookup_idx ON bus_pair_codes (code_hash) WHERE used_at IS NULL;

-- GPS samples now come from either a staff phone (member_id) or a bus tracker (device_id).
ALTER TABLE trip_location_samples
  ADD COLUMN device_id uuid REFERENCES bus_devices(id),
  ALTER COLUMN member_id DROP NOT NULL,
  ADD CONSTRAINT trip_location_samples_one_sender
    CHECK ((member_id IS NULL) <> (device_id IS NULL));

-- Same rules as before (030), plus: a tracker may only report for a trip on its own bus.
CREATE OR REPLACE FUNCTION accept_trip_location_sample()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  trip_started_at timestamptz;
  trip_status text;
  trip_bus_id uuid;
BEGIN
  SELECT status, started_at, bus_id
    INTO trip_status, trip_started_at, trip_bus_id
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

  IF NEW.device_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM bus_devices
       WHERE id = NEW.device_id
         AND bus_id = trip_bus_id
         AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION 'GPS sender is not the tracker for this bus';
    END IF;
  ELSIF NOT EXISTS (
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
