-- Staff may be scheduled for more than one future trip. The operational
-- invariant is one active trip at a time, not one open assignment forever.

DROP INDEX IF EXISTS one_open_trip_per_staff;

CREATE OR REPLACE FUNCTION require_staff_before_trip_start()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assigned_member_id uuid;
BEGIN
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    SELECT a.member_id INTO assigned_member_id
      FROM staff_assignments a
      JOIN members m ON m.id = a.member_id
      JOIN member_roles r
        ON r.member_id = m.id
       AND r.role = 'staff'
       AND r.revoked_at IS NULL
     WHERE a.trip_id = NEW.id
       AND a.ended_at IS NULL
       AND m.suspended_at IS NULL
     LIMIT 1;

    IF assigned_member_id IS NULL THEN
      RAISE EXCEPTION 'Trip requires an assigned active staff member before start';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM staff_assignments other_assignment
        JOIN trips other_trip ON other_trip.id = other_assignment.trip_id
       WHERE other_assignment.member_id = assigned_member_id
         AND other_assignment.ended_at IS NULL
         AND other_assignment.trip_id <> NEW.id
         AND other_trip.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Assigned staff member is already running another active trip';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
