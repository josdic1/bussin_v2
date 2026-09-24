-- A guardian is a contact; linking an optional account is a separate fact.
CREATE TABLE guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  email text CHECK (email IS NULL OR email = lower(trim(email))),
  phone text CHECK (phone IS NULL OR length(trim(phone)) BETWEEN 1 AND 40),
  member_id uuid UNIQUE REFERENCES members(id),
  import_dataset text,
  import_key text,
  CHECK ((import_dataset IS NULL) = (import_key IS NULL))
);

CREATE UNIQUE INDEX guardians_source_key_idx ON guardians (import_dataset, import_key)
  WHERE import_dataset IS NOT NULL;

INSERT INTO guardians (id, name, email, phone, member_id)
SELECT m.id, m.display_name, m.email, c.phone_e164, m.id
  FROM members m
  LEFT JOIN guardian_contacts c ON c.member_id = m.id
 WHERE EXISTS (SELECT 1 FROM member_roles role
               WHERE role.member_id = m.id AND role.role = 'family' AND role.revoked_at IS NULL)
    OR EXISTS (SELECT 1 FROM rider_guardians rg WHERE rg.member_id = m.id)
    OR c.member_id IS NOT NULL;

INSERT INTO guardians (id, name, email, phone, import_dataset, import_key)
SELECT id, name, email, phone, import_dataset, import_key FROM roster_guardians;

CREATE TABLE rider_guardian_links (
  rider_id uuid NOT NULL REFERENCES riders(id),
  guardian_id uuid NOT NULL REFERENCES guardians(id),
  source text NOT NULL CHECK (source IN ('import', 'manual')),
  PRIMARY KEY (rider_id, guardian_id)
);

INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
SELECT rider_id, member_id, 'manual' FROM rider_guardians;

INSERT INTO rider_guardian_links (rider_id, guardian_id, source)
SELECT rider_id, guardian_id, 'import' FROM roster_rider_guardians;

DROP TABLE roster_rider_guardians;
DROP TABLE rider_guardians;
DROP TABLE guardian_contacts;
DROP TABLE roster_guardians;
