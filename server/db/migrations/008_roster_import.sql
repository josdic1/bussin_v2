-- Imported roster contacts exist independently of sign-in accounts.
-- The existing manual rider records remain intact.
ALTER TABLE riders
  ADD COLUMN import_dataset text,
  ADD COLUMN import_key text,
  ADD CONSTRAINT riders_import_identity_check CHECK (
    (import_dataset IS NULL) = (import_key IS NULL)
  );

CREATE UNIQUE INDEX riders_import_identity_idx
  ON riders (import_dataset, import_key)
  WHERE import_dataset IS NOT NULL;

CREATE TABLE roster_guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_dataset text NOT NULL,
  import_key text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR email = lower(trim(email))),
  phone text,
  UNIQUE (import_dataset, import_key)
);

CREATE TABLE roster_rider_guardians (
  rider_id uuid NOT NULL REFERENCES riders(id),
  guardian_id uuid NOT NULL REFERENCES roster_guardians(id),
  PRIMARY KEY (rider_id, guardian_id)
);
