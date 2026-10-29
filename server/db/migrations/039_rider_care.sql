-- What a counselor needs to know about a kid on the bus: care notes (allergies, medication,
-- anything to watch for) and an emergency contact who isn't already a guardian.
-- Entered by the camp office; shown on the phones of the counselors on that kid's trip.
ALTER TABLE riders
  ADD COLUMN care_notes text
    CHECK (care_notes IS NULL OR length(trim(care_notes)) BETWEEN 1 AND 500),
  ADD COLUMN emergency_name text
    CHECK (emergency_name IS NULL OR length(trim(emergency_name)) BETWEEN 1 AND 120),
  ADD COLUMN emergency_phone text
    CHECK (emergency_phone IS NULL OR length(trim(emergency_phone)) BETWEEN 1 AND 40);
