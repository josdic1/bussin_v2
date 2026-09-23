ALTER TABLE members
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN username text,
  ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;

ALTER TABLE members
  ADD CONSTRAINT members_login_identity_required
  CHECK (email IS NOT NULL OR username IS NOT NULL),
  ADD CONSTRAINT members_username_format
  CHECK (
    username IS NULL OR (
      username = lower(trim(username))
      AND username ~ '^[a-z0-9_]{3,32}$'
    )
  );

CREATE UNIQUE INDEX members_username_unique
  ON members (username) WHERE username IS NOT NULL;
