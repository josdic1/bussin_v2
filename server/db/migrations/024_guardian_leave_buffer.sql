-- Leave timing is a guardian preference, not a household or rider permission.
ALTER TABLE guardians
  ADD COLUMN leave_buffer_minutes smallint NOT NULL DEFAULT 5
  CHECK (leave_buffer_minutes BETWEEN 0 AND 60);
