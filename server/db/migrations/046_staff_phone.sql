-- A phone number for each counselor, so Dispatch can call the lead from the bus card.
ALTER TABLE members
  ADD COLUMN phone text CHECK (phone IS NULL OR length(trim(phone)) BETWEEN 1 AND 40);
