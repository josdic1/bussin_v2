-- Keep only the latest foreground heartbeat for each staff member.
-- Dispatch uses this to distinguish a currently reporting staff phone from a
-- phone/app that has stopped reporting, without storing a presence history.
CREATE TABLE staff_presence (
  member_id uuid PRIMARY KEY REFERENCES members(id),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
