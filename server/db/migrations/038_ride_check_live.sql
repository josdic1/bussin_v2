-- Counselor phones share one Ride Check list per trip. When anyone taps a kid (or
-- checks the bus empty), every phone on that trip's crew hears about it right away,
-- through the same channel trip changes already use (021).
CREATE TRIGGER notify_staff_rider_event
AFTER INSERT ON trip_rider_events
FOR EACH ROW EXECUTE FUNCTION notify_staff_trip_change();

CREATE TRIGGER notify_staff_trip_sweep
AFTER INSERT ON trip_sweeps
FOR EACH ROW EXECUTE FUNCTION notify_staff_trip_change();
