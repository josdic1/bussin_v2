-- What the office needs on file for each bus: plate, the company that runs it, seats,
-- and the two dates that expire (inspection, insurance). All optional; the Buses page
-- shows what's missing or expired in red.
ALTER TABLE buses
  ADD COLUMN plate text CHECK (plate IS NULL OR length(trim(plate)) BETWEEN 1 AND 20),
  ADD COLUMN company text CHECK (company IS NULL OR length(trim(company)) BETWEEN 1 AND 120),
  ADD COLUMN seats smallint CHECK (seats IS NULL OR seats BETWEEN 1 AND 120),
  ADD COLUMN inspection_due date,
  ADD COLUMN insurance_expires date,
  ADD COLUMN notes text CHECK (notes IS NULL OR length(trim(notes)) BETWEEN 1 AND 500);
