-- Ride Check: who is on the bus, recorded per rider per trip.
-- Membership comes from the trip_riders snapshot. Check events are an
-- append-only log; a rider's current state is derived from their latest
-- state-changing event, never stored as a mutable column.

CREATE TABLE trip_rider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  event_type text NOT NULL CHECK (
    event_type IN ('boarded', 'dropped_off', 'no_show', 'not_riding', 'undone', 'handled')
  ),
  recorded_by uuid NOT NULL REFERENCES members(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trip_rider_events_timeline_idx
  ON trip_rider_events (trip_id, rider_id, occurred_at, recorded_at);

-- A check can only be recorded for a rider on the trip's snapshot, and never
-- on a cancelled trip. Planned trips only accept "not riding" and its undo.
CREATE FUNCTION validate_trip_rider_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status FROM trips WHERE id = NEW.trip_id;

  IF current_status = 'cancelled' THEN
    RAISE EXCEPTION 'Ride checks cannot be recorded on a cancelled trip';
  END IF;

  IF current_status = 'planned'
     AND NEW.event_type NOT IN ('not_riding', 'undone') THEN
    RAISE EXCEPTION 'Only not riding can be recorded before the trip starts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trip_riders
     WHERE trip_id = NEW.trip_id AND rider_id = NEW.rider_id
  ) THEN
    RAISE EXCEPTION 'Rider is not on this trip';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_trip_rider_event
BEFORE INSERT ON trip_rider_events
FOR EACH ROW EXECUTE FUNCTION validate_trip_rider_event();

CREATE TRIGGER deny_trip_rider_event_mutation
BEFORE UPDATE OR DELETE ON trip_rider_events
FOR EACH ROW EXECUTE FUNCTION deny_trip_history_mutation();

-- End-of-trip walk-through: someone confirmed nobody is left on the bus.
CREATE TABLE trip_sweeps (
  trip_id uuid PRIMARY KEY REFERENCES trips(id),
  recorded_by uuid NOT NULL REFERENCES members(id),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION validate_trip_sweep()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trips WHERE id = NEW.trip_id AND status IN ('active', 'completed')
  ) THEN
    RAISE EXCEPTION 'Only a running or completed trip can be checked empty';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_trip_sweep
BEFORE INSERT ON trip_sweeps
FOR EACH ROW EXECUTE FUNCTION validate_trip_sweep();

CREATE TRIGGER deny_trip_sweep_mutation
BEFORE UPDATE OR DELETE ON trip_sweeps
FOR EACH ROW EXECUTE FUNCTION deny_trip_history_mutation();

-- Roster edits resync trip_riders for planned trips by delete + insert.
-- Riders with a recorded check (for example, marked not riding in advance)
-- keep their seat on the snapshot so their history is not orphaned.
CREATE OR REPLACE FUNCTION keep_checked_trip_riders()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM trip_rider_events
     WHERE trip_id = OLD.trip_id AND rider_id = OLD.rider_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER keep_checked_trip_riders
BEFORE DELETE ON trip_riders
FOR EACH ROW EXECUTE FUNCTION keep_checked_trip_riders();
