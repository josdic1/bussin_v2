-- Family access is derived from guardian -> rider -> trip membership.
-- The old route/trip permission tables were never wired to the roster and would
-- create a second, conflicting source of truth.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM family_route_access LIMIT 1)
     OR EXISTS (SELECT 1 FROM family_trip_access LIMIT 1) THEN
    RAISE EXCEPTION 'Legacy family access rows exist. Review them before migration; refusing to guess access.';
  END IF;
END $$;

DROP TABLE family_trip_access;
DROP TABLE family_route_access;

CREATE TABLE trip_riders (
  trip_id uuid NOT NULL REFERENCES trips(id),
  rider_id uuid NOT NULL REFERENCES riders(id),
  trip_stop_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, rider_id),
  FOREIGN KEY (trip_id, trip_stop_id)
    REFERENCES trip_stops(trip_id, id)
);

CREATE INDEX trip_riders_rider_idx ON trip_riders (rider_id, trip_id);
CREATE INDEX rider_guardian_links_guardian_idx ON rider_guardian_links (guardian_id, rider_id);

-- Only planned trips can be reconstructed safely from today's roster.
-- We intentionally do not invent rider membership for historical trips.
INSERT INTO trip_riders (trip_id, rider_id, trip_stop_id)
SELECT t.id, a.rider_id, ts.id
  FROM trips t
  JOIN rider_stop_assignments a ON a.route_id = t.route_id
  JOIN trip_stops ts
    ON ts.trip_id = t.id
   AND ts.route_stop_id = a.route_stop_id
 WHERE t.status = 'planned';

-- This view is the one family authorization rule:
-- signed-in member -> linked guardian -> linked rider -> rider on trip.
CREATE VIEW family_trip_access AS
SELECT g.member_id,
       g.id AS guardian_id,
       rg.rider_id,
       tr.trip_id,
       tr.trip_stop_id
  FROM guardians g
  JOIN rider_guardian_links rg ON rg.guardian_id = g.id
  JOIN trip_riders tr ON tr.rider_id = rg.rider_id
 WHERE g.member_id IS NOT NULL;
