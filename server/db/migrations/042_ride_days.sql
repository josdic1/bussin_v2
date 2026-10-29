-- Which days of the week a kid rides the bus. NULL means every day the bus runs.
-- ISO weekdays: 1 = Monday ... 7 = Sunday. A kid is put on a trip only on their days,
-- both ways (morning and afternoon). A kid with no bus one way has no stop for it.
ALTER TABLE riders
  ADD COLUMN ride_days smallint[]
    CHECK (ride_days IS NULL OR (cardinality(ride_days) BETWEEN 1 AND 6
      AND ride_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]));
