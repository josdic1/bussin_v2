-- The system-admin guard from 006 returned NEW for every operation. On DELETE,
-- NEW is NULL, and a BEFORE trigger returning NULL silently skips the row, so
-- no member could ever be deleted. Keep the same protection, return OLD on DELETE.
CREATE OR REPLACE FUNCTION protect_system_admin_member()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.username = 'admin' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'The system admin cannot be deleted';
    END IF;

    IF NEW.username IS DISTINCT FROM 'admin'
       OR NEW.suspended_at IS NOT NULL
       OR NEW.password_hash IS NULL
       OR NEW.activated_at IS NULL THEN
      RAISE EXCEPTION 'The system admin cannot be disabled';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
