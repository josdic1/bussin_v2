-- Repeating trips. One row says: this bus runs this route, leaving at this time, on these
-- weekdays, between these dates, with this crew. Bussin builds the real trips two weeks
-- ahead from it. A built trip is an ordinary trip: edit, cancel or re-crew it like any other.
-- Weekdays are ISO: 1 = Monday ... 7 = Sunday. Times are the camp's local time.
CREATE TABLE trip_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES routes(id),
  bus_id uuid NOT NULL REFERENCES buses(id),
  weekdays smallint[] NOT NULL
    CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  depart_time time NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  lead_id uuid REFERENCES members(id),
  counselor_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(counselor_ids) <= 3),
  driver_id uuid REFERENCES drivers(id),
  stopped_at timestamptz,
  created_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on AND ends_on <= starts_on + 366)
);

-- Which repeating trip built a trip, and for which day. One trip per schedule per day, ever:
-- a day someone cancelled stays cancelled instead of being built again.
ALTER TABLE trips
  ADD COLUMN schedule_id uuid REFERENCES trip_schedules(id),
  ADD COLUMN service_date date,
  ADD CONSTRAINT trips_schedule_day_pair CHECK ((schedule_id IS NULL) = (service_date IS NULL));

CREATE UNIQUE INDEX trips_schedule_day_idx ON trips (schedule_id, service_date) WHERE schedule_id IS NOT NULL;
