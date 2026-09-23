CREATE UNIQUE INDEX trip_location_samples_observed_once
  ON trip_location_samples (trip_id, observed_at);
