CREATE TABLE schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  activated_at timestamptz,
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  CHECK ((password_hash IS NULL) = (activated_at IS NULL))
);

CREATE TABLE member_roles (
  member_id uuid NOT NULL REFERENCES members(id),
  role text NOT NULL CHECK (role IN ('admin', 'dispatch', 'staff', 'family')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (member_id, role)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'dispatch', 'staff', 'family')),
  token_hash bytea NOT NULL UNIQUE,
  invited_by uuid REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES members(id),
  CHECK (email = lower(trim(email))),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_member_idx ON sessions (member_id, expires_at);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

INSERT INTO schema_migrations (version, name) VALUES (1, 'auth');
