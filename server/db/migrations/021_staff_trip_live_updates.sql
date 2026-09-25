-- Staff phones must learn about assignment and trip-state changes without a
-- manual refresh. PostgreSQL publishes only the affected member id; the server
-- filters each notification to the authenticated staff connection.
CREATE OR REPLACE FUNCTION notify_staff_assignment_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify(
      'bussin_staff_trip',
      json_build_object('memberId', OLD.member_id)::text
    );
    RETURN OLD;
  END IF;

  PERFORM pg_notify(
    'bussin_staff_trip',
    json_build_object('memberId', NEW.member_id)::text
  );

  IF TG_OP = 'UPDATE' AND OLD.member_id IS DISTINCT FROM NEW.member_id THEN
    PERFORM pg_notify(
      'bussin_staff_trip',
      json_build_object('memberId', OLD.member_id)::text
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_staff_assignment_change ON staff_assignments;
CREATE TRIGGER notify_staff_assignment_change
AFTER INSERT OR UPDATE OR DELETE ON staff_assignments
FOR EACH ROW EXECUTE FUNCTION notify_staff_assignment_change();

CREATE OR REPLACE FUNCTION notify_staff_trip_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_trip_id uuid;
  assigned_member_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'trips' THEN
    affected_trip_id := NEW.id;
  ELSE
    affected_trip_id := NEW.trip_id;
  END IF;

  FOR assigned_member_id IN
    SELECT DISTINCT member_id
      FROM staff_assignments
     WHERE trip_id = affected_trip_id
  LOOP
    PERFORM pg_notify(
      'bussin_staff_trip',
      json_build_object('memberId', assigned_member_id)::text
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_staff_trip_status_change ON trips;
CREATE TRIGGER notify_staff_trip_status_change
AFTER UPDATE OF status ON trips
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION notify_staff_trip_change();

DROP TRIGGER IF EXISTS notify_staff_trip_event_change ON trip_events;
CREATE TRIGGER notify_staff_trip_event_change
AFTER INSERT ON trip_events
FOR EACH ROW EXECUTE FUNCTION notify_staff_trip_change();
