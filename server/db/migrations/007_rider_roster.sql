CREATE TABLE riders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  given_name text NOT NULL CHECK (length(trim(given_name)) BETWEEN 1 AND 80),
  family_name text NOT NULL CHECK (length(trim(family_name)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rider_guardians (
  rider_id uuid NOT NULL REFERENCES riders(id),
  member_id uuid NOT NULL REFERENCES members(id),
  PRIMARY KEY (rider_id, member_id)
);

CREATE INDEX rider_guardians_member_idx ON rider_guardians (member_id);

CREATE TABLE guardian_contacts (
  member_id uuid PRIMARY KEY REFERENCES members(id),
  phone_e164 text CHECK (phone_e164 ~ '^[+][1-9][0-9]{1,14}$')
);

CREATE TABLE rider_stop_assignments (
  rider_id uuid NOT NULL REFERENCES riders(id),
  direction text NOT NULL CHECK (direction IN ('AM', 'PM')),
  route_id uuid NOT NULL,
  route_stop_id uuid NOT NULL,
  PRIMARY KEY (rider_id, direction),
  FOREIGN KEY (route_id, route_stop_id)
    REFERENCES route_stops(route_id, id)
);

CREATE INDEX rider_stop_assignments_stop_idx
  ON rider_stop_assignments (route_id, route_stop_id);
