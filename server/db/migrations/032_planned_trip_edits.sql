-- A plan can change before operation starts; a running or historical trip cannot.
CREATE FUNCTION protect_operational_trip_plan()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route_id, NEW.bus_id, NEW.departure_at)
       IS DISTINCT FROM (OLD.route_id, OLD.bus_id, OLD.departure_at)
     AND (OLD.status <> 'planned' OR NEW.status <> 'planned') THEN
    RAISE EXCEPTION 'Only a planned trip can be edited';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_operational_trip_plan
BEFORE UPDATE OF route_id, bus_id, departure_at ON trips
FOR EACH ROW EXECUTE FUNCTION protect_operational_trip_plan();
