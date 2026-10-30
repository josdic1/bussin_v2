-- A line is a route family: its morning route and its afternoon route, run by one bus.
-- Each line gets its own color on the Lines page and on Dispatch.
ALTER TABLE route_families
  ADD COLUMN color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');
