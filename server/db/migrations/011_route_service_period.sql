ALTER TABLE routes
  ADD COLUMN service_period text;

UPDATE routes
SET service_period = CASE
  WHEN upper(trim(name)) ~ '(^|[_[:space:]-])AM$' THEN 'AM'
  WHEN upper(trim(name)) ~ '(^|[_[:space:]-])PM$' THEN 'PM'
  ELSE NULL
END;

DO $$
DECLARE
  missing_routes text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name)
    INTO missing_routes
    FROM routes
   WHERE service_period IS NULL;

  IF missing_routes IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot infer AM/PM service period for existing routes: %',
      missing_routes;
  END IF;
END
$$;

ALTER TABLE routes
  ALTER COLUMN service_period SET NOT NULL,
  ADD CONSTRAINT routes_service_period_check
    CHECK (service_period IN ('AM', 'PM')),
  ADD CONSTRAINT routes_id_service_period_unique
    UNIQUE (id, service_period);

ALTER TABLE rider_stop_assignments
  ADD CONSTRAINT rider_stop_assignments_route_period_fkey
    FOREIGN KEY (route_id, direction)
    REFERENCES routes(id, service_period);

CREATE INDEX routes_service_period_idx
  ON routes (service_period, name);
