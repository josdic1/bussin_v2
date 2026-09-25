-- A cancelled trip may have been cancelled before it started or while active.
-- Preserve that distinction in started_at/ended_at instead of forcing every
-- cancelled trip to look like it never ran.

ALTER TABLE trips DROP CONSTRAINT trips_check;

ALTER TABLE trips ADD CONSTRAINT trips_check CHECK (
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
    AND cancelled_at IS NOT NULL
    AND (
      (started_at IS NULL AND ended_at IS NULL)
      OR
      (started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= started_at)
    ))
);
