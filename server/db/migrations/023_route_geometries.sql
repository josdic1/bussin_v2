-- Store one expected road path for each immutable route revision.
-- Traffic-aware travel time remains live trip data and is not stored here.
CREATE TABLE route_geometries (
  route_id uuid PRIMARY KEY REFERENCES routes(id) ON DELETE CASCADE,
  geometry jsonb NOT NULL,
  distance_m double precision NOT NULL CHECK (distance_m > 0),
  provider text NOT NULL CHECK (provider = 'mapbox'),
  profile text NOT NULL CHECK (profile = 'driving'),
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_geometries_linestring
    CHECK (
      geometry->>'type' = 'LineString'
      AND jsonb_typeof(geometry->'coordinates') = 'array'
      AND jsonb_array_length(geometry->'coordinates') >= 2
    )
);
