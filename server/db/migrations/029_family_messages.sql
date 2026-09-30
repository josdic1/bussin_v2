-- Messages an admin sends to families. The recipient list is fixed when the
-- message is sent, so a guardian added later does not see old messages, and
-- read counts always refer to the people it was actually sent to.
CREATE TABLE family_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  audience text NOT NULL CHECK (audience IN ('all', 'route', 'trip', 'rider')),
  route_family_id uuid REFERENCES route_families(id),
  trip_id uuid REFERENCES trips(id),
  rider_id uuid REFERENCES riders(id),
  audience_label text NOT NULL CHECK (length(trim(audience_label)) BETWEEN 1 AND 200),
  -- The name is kept so the history still reads right if that login is later removed.
  sent_by uuid REFERENCES members(id) ON DELETE SET NULL,
  sent_by_name text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  CHECK ((audience = 'route') = (route_family_id IS NOT NULL)),
  CHECK ((audience = 'trip') = (trip_id IS NOT NULL)),
  CHECK ((audience = 'rider') = (rider_id IS NOT NULL))
);

CREATE INDEX family_messages_sent_idx ON family_messages (sent_at DESC);

CREATE TABLE family_message_recipients (
  message_id uuid NOT NULL REFERENCES family_messages(id),
  guardian_id uuid NOT NULL REFERENCES guardians(id),
  read_at timestamptz,
  PRIMARY KEY (message_id, guardian_id)
);

CREATE INDEX family_message_recipients_guardian_idx
  ON family_message_recipients (guardian_id, message_id);
