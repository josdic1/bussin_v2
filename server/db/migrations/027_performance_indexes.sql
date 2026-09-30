-- Indexes for the hot read paths. No data or behavior changes.

-- Every arrived/departed lookup checks "has this event been corrected?" with
-- NOT EXISTS (... WHERE replaces_event_id = e.id). Without an index that is a
-- scan of trip_events per stop, per board poll.
CREATE INDEX IF NOT EXISTS trip_events_replaces_idx
  ON trip_events (replaces_event_id)
  WHERE replaces_event_id IS NOT NULL;

-- Latest arrival/departure per trip stop.
CREATE INDEX IF NOT EXISTS trip_events_stop_lookup_idx
  ON trip_events (trip_id, trip_stop_id, event_type, occurred_at DESC)
  WHERE trip_stop_id IS NOT NULL;

-- The board always includes running trips regardless of the chosen day.
CREATE INDEX IF NOT EXISTS trips_active_idx
  ON trips (departure_at)
  WHERE status = 'active';
