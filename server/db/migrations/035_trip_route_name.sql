-- Trips keep their own copy of the route name, the same way they keep their own stops.
-- Renaming a route renames the trips that haven't run yet. Running, finished and
-- cancelled trips keep the name they ran under, so history never changes.

ALTER TABLE trips ADD COLUMN route_name text;

UPDATE trips t SET route_name = r.name FROM routes r WHERE r.id = t.route_id;

ALTER TABLE trips ALTER COLUMN route_name SET NOT NULL;

-- New trips, and planned trips moved to another route, take that route's current name.
CREATE FUNCTION set_trip_route_name()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.route_id IS DISTINCT FROM OLD.route_id THEN
    SELECT name INTO NEW.route_name FROM routes WHERE id = NEW.route_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_trip_route_name
BEFORE INSERT OR UPDATE OF route_id ON trips
FOR EACH ROW EXECUTE FUNCTION set_trip_route_name();

-- A route rename reaches only trips that haven't started.
CREATE FUNCTION rename_planned_trips()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE trips SET route_name = NEW.name
   WHERE route_id = NEW.id AND status = 'planned' AND route_name IS DISTINCT FROM NEW.name;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rename_planned_trips
AFTER UPDATE OF name ON routes
FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION rename_planned_trips();
