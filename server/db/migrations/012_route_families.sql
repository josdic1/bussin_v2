CREATE TABLE route_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(name)) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX route_families_name_unique
  ON route_families (lower(trim(name)));

INSERT INTO route_families (name)
VALUES ('Alpha'), ('Beta'), ('Gamma'), ('Delta'), ('Epsilon');

ALTER TABLE routes
  ADD COLUMN route_family_id uuid;

UPDATE routes r
SET route_family_id = rf.id
FROM route_families rf
WHERE rf.name = CASE r.name
  WHEN 'Alpha_1-stop_AM' THEN 'Alpha'
  WHEN 'Alpha_1-stop_PM' THEN 'Alpha'
  WHEN 'Beta_1-stop_AM' THEN 'Beta'
  WHEN 'Beta_1-stop_PM' THEN 'Beta'
  WHEN 'Gamma_1-stop_AM' THEN 'Gamma'
  WHEN 'Gamma_1-stop_PM' THEN 'Gamma'
  WHEN 'Delta_2-stop_AM' THEN 'Delta'
  WHEN 'Delta_2-stop_PM' THEN 'Delta'
  WHEN 'Epsilon_3-stop_AM' THEN 'Epsilon'
  WHEN 'Epsilon_3-stop_PM' THEN 'Epsilon'
  ELSE NULL
END;

DO $$
DECLARE
  missing_routes text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name)
    INTO missing_routes
    FROM routes
   WHERE route_family_id IS NULL;

  IF missing_routes IS NOT NULL THEN
    RAISE EXCEPTION
      'No explicit route-family mapping exists for: %',
      missing_routes;
  END IF;
END
$$;

ALTER TABLE routes
  ALTER COLUMN route_family_id SET NOT NULL,
  ADD CONSTRAINT routes_route_family_fkey
    FOREIGN KEY (route_family_id) REFERENCES route_families(id);

CREATE INDEX routes_route_family_idx
  ON routes (route_family_id, service_period, active);
