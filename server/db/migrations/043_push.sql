-- Phone notifications (Web Push). A subscription is one browser on one phone that said yes.
-- push_sent remembers which alert each person already got for each trip, so a restart or a
-- second server never sends "Bus 1 left Camp" twice.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 200),
  auth text NOT NULL CHECK (length(auth) BETWEEN 1 AND 100),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
CREATE INDEX push_subscriptions_member_idx ON push_subscriptions (member_id);

CREATE TABLE push_sent (
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES trips(id),
  kind text NOT NULL CHECK (kind IN ('left', 'near', 'arrived')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, trip_id, kind)
);
