CREATE TABLE buses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(label)) BETWEEN 1 AND 80)
);

CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(name)) BETWEEN 1 AND 120)
);

CREATE TABLE route_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES routes(id),
  position integer NOT NULL CHECK (position > 0),
  label text NOT NULL,
  latitude numeric(9,6),
  longitude numeric(9,6),
  UNIQUE (route_id, position),
  UNIQUE (route_id, id),
  CHECK (length(trim(label)) BETWEEN 1 AND 120),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
);

CREATE TABLE scheduled_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES routes(id),
  departure_at timestamptz NOT NULL,
  planned_staff_id uuid REFERENCES members(id),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, route_id)
);

CREATE INDEX scheduled_runs_departure_idx ON scheduled_runs (departure_at);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_run_id uuid UNIQUE,
  route_id uuid NOT NULL REFERENCES routes(id),
  bus_id uuid NOT NULL REFERENCES buses(id),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  started_at timestamptz,
  ended_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (scheduled_run_id, route_id)
    REFERENCES scheduled_runs(id, route_id),
  UNIQUE (id, route_id),
  CHECK (
    (status = 'planned'
      AND started_at IS NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR
    (status = 'active'
      AND started_at IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR
    (status = 'completed'
      AND started_at IS NOT NULL AND ended_at >= started_at
      AND cancelled_at IS NULL)
    OR
    (status = 'cancelled'
      AND started_at IS NULL AND ended_at IS NULL
      AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX trips_one_active_bus
  ON trips (bus_id) WHERE status = 'active';

CREATE TABLE trip_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_stop_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  label text NOT NULL,
  latitude numeric(9,6),
  longitude numeric(9,6),
  FOREIGN KEY (trip_id, route_id) REFERENCES trips(id, route_id),
  FOREIGN KEY (route_id, route_stop_id) REFERENCES route_stops(route_id, id),
  UNIQUE (trip_id, position),
  UNIQUE (trip_id, id),
  CHECK (length(trim(label)) BETWEEN 1 AND 120),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
);

CREATE TABLE staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  member_id uuid NOT NULL REFERENCES members(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

CREATE UNIQUE INDEX one_open_staff_per_trip
  ON staff_assignments (trip_id) WHERE ended_at IS NULL;

CREATE UNIQUE INDEX one_open_trip_per_staff
  ON staff_assignments (member_id) WHERE ended_at IS NULL;

CREATE TABLE family_route_access (
  member_id uuid NOT NULL REFERENCES members(id),
  route_id uuid NOT NULL,
  route_stop_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (member_id, route_id, route_stop_id),
  FOREIGN KEY (route_id, route_stop_id)
    REFERENCES route_stops(route_id, id)
);

CREATE TABLE family_trip_access (
  member_id uuid NOT NULL REFERENCES members(id),
  trip_id uuid NOT NULL REFERENCES trips(id),
  trip_stop_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (member_id, trip_id, trip_stop_id),
  FOREIGN KEY (trip_id, trip_stop_id)
    REFERENCES trip_stops(trip_id, id)
);

CREATE INDEX family_trip_access_trip_idx
  ON family_trip_access (trip_id) WHERE revoked_at IS NULL;
