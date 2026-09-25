-- Route revisions preserve historical trip truth while allowing the current
-- operational route to change. A route family + service period has one current
-- revision; superseded revisions remain for historical trips.

ALTER TABLE routes DROP CONSTRAINT routes_name_key;

ALTER TABLE routes
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN supersedes_route_id uuid REFERENCES routes(id),
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT routes_not_self_superseding
    CHECK (supersedes_route_id IS NULL OR supersedes_route_id <> id),
  ADD CONSTRAINT routes_superseded_inactive
    CHECK (superseded_at IS NULL OR active = false);

CREATE UNIQUE INDEX routes_family_period_revision_unique
  ON routes (route_family_id, service_period, revision);

CREATE UNIQUE INDEX routes_one_current_family_period
  ON routes (route_family_id, service_period)
  WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX routes_one_successor
  ON routes (supersedes_route_id)
  WHERE supersedes_route_id IS NOT NULL;
