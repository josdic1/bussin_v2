-- A staff assignment is a real operational relationship, not a loose label.
-- Only active staff may be assigned, only while a trip is planned, and a trip
-- cannot become active without one valid open assignment.

CREATE FUNCTION validate_staff_assignment_target()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  trip_status text;
BEGIN
  SELECT status INTO trip_status
    FROM trips
   WHERE id = NEW.trip_id;

  IF trip_status IS DISTINCT FROM 'planned' THEN
    RAISE EXCEPTION 'Staff can only be assigned while a trip is planned';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM members m
      JOIN member_roles r
        ON r.member_id = m.id
       AND r.role = 'staff'
       AND r.revoked_at IS NULL
     WHERE m.id = NEW.member_id
       AND m.suspended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Assigned member must be active staff';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_staff_assignment_target
BEFORE INSERT OR UPDATE OF trip_id, member_id ON staff_assignments
FOR EACH ROW EXECUTE FUNCTION validate_staff_assignment_target();

CREATE FUNCTION require_staff_before_trip_start()
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
         AND m.suspended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Trip requires an assigned active staff member before start';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER require_staff_before_trip_start
BEFORE UPDATE OF status ON trips
FOR EACH ROW EXECUTE FUNCTION require_staff_before_trip_start();

CREATE FUNCTION close_staff_assignment_after_trip()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE staff_assignments
       SET ended_at = GREATEST(now(), assigned_at)
     WHERE trip_id = NEW.id
       AND ended_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER close_staff_assignment_after_trip
AFTER UPDATE OF status ON trips
FOR EACH ROW EXECUTE FUNCTION close_staff_assignment_after_trip();
