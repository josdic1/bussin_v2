-- Trip crew: one driver plus a lead counselor and up to 3 more counselors.
--
-- Drivers are people, not logins. Camps get drivers from the bus company and
-- they change constantly; they never sign in. A driver is a name and phone on
-- the trip so there is always a record of who was driving.
--
-- Counselors are staff logins (existing staff_assignments). Each open
-- assignment now says whether it is the trip's lead or an extra counselor.
-- Existing assignments become leads, so every current trip keeps working
-- exactly as before.

-- ---------- Drivers ----------

CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  phone text CHECK (phone IS NULL OR length(trim(phone)) BETWEEN 1 AND 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX drivers_active_name_idx ON drivers (active, name);

-- Who drove a trip, with history: a swap ends one row and opens another.
CREATE TABLE trip_driver_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  driver_id uuid NOT NULL REFERENCES drivers(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

-- One driver at a time per trip.
CREATE UNIQUE INDEX one_open_driver_per_trip
  ON trip_driver_assignments (trip_id) WHERE ended_at IS NULL;

CREATE INDEX trip_driver_assignments_trip_idx
  ON trip_driver_assignments (trip_id, assigned_at);

-- Drivers can be set before the trip and swapped while it runs (a driver can
-- hand off mid-route). Never on a finished or cancelled trip, never a retired driver.
CREATE FUNCTION validate_trip_driver_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  trip_status text;
BEGIN
  SELECT status INTO trip_status FROM trips WHERE id = NEW.trip_id;
  IF trip_status NOT IN ('planned', 'active') THEN
    RAISE EXCEPTION 'A driver can only be assigned to a planned or running trip';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM drivers WHERE id = NEW.driver_id AND active) THEN
    RAISE EXCEPTION 'Assigned driver must be active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_trip_driver_assignment
BEFORE INSERT OR UPDATE OF trip_id, driver_id ON trip_driver_assignments
FOR EACH ROW EXECUTE FUNCTION validate_trip_driver_assignment();

-- The driver record closes when the trip ends, the same way staff assignments do.
CREATE FUNCTION close_driver_assignment_after_trip()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE trip_driver_assignments
       SET ended_at = GREATEST(now(), assigned_at)
     WHERE trip_id = NEW.id
       AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER close_driver_assignment_after_trip
AFTER UPDATE OF status ON trips
FOR EACH ROW EXECUTE FUNCTION close_driver_assignment_after_trip();

-- ---------- Counselors ----------

ALTER TABLE staff_assignments
  ADD COLUMN crew_role text NOT NULL DEFAULT 'lead'
  CHECK (crew_role IN ('lead', 'counselor'));

-- Was: one open staff assignment per trip. Now: one open lead per trip,
-- each person on a trip once, and at most 4 counselors (lead included).
DROP INDEX IF EXISTS one_open_staff_per_trip;

CREATE UNIQUE INDEX one_open_lead_per_trip
  ON staff_assignments (trip_id) WHERE ended_at IS NULL AND crew_role = 'lead';

CREATE UNIQUE INDEX one_open_seat_per_member_per_trip
  ON staff_assignments (trip_id, member_id) WHERE ended_at IS NULL;

CREATE FUNCTION limit_trip_counselors()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NULL THEN
    -- Serialize changes to one trip's crew so two people can't both add the 5th counselor.
    PERFORM 1 FROM trips WHERE id = NEW.trip_id FOR UPDATE;
    IF (SELECT count(*) FROM staff_assignments
         WHERE trip_id = NEW.trip_id AND ended_at IS NULL AND id <> NEW.id) >= 4 THEN
      RAISE EXCEPTION 'A trip can have at most 4 counselors';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER limit_trip_counselors
BEFORE INSERT OR UPDATE OF trip_id, ended_at ON staff_assignments
FOR EACH ROW EXECUTE FUNCTION limit_trip_counselors();

-- A trip starts only with an active lead counselor, and nobody on the crew may
-- already be on another running trip.
CREATE OR REPLACE FUNCTION require_staff_before_trip_start()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM staff_assignments a
        JOIN members m ON m.id = a.member_id
        JOIN member_roles r
          ON r.member_id = m.id
         AND r.role = 'staff'
         AND r.revoked_at IS NULL
       WHERE a.trip_id = NEW.id
         AND a.ended_at IS NULL
         AND a.crew_role = 'lead'
         AND m.suspended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Trip requires an assigned active staff member before start';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM staff_assignments mine
        JOIN staff_assignments other_assignment
          ON other_assignment.member_id = mine.member_id
         AND other_assignment.ended_at IS NULL
         AND other_assignment.trip_id <> NEW.id
        JOIN trips other_trip ON other_trip.id = other_assignment.trip_id
       WHERE mine.trip_id = NEW.id
         AND mine.ended_at IS NULL
         AND other_trip.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Assigned staff member is already running another active trip';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
