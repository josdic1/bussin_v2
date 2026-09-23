CREATE FUNCTION protect_system_admin_member()
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_system_admin_member
BEFORE UPDATE OR DELETE ON members
FOR EACH ROW EXECUTE FUNCTION protect_system_admin_member();

CREATE FUNCTION protect_system_admin_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'admin' AND EXISTS (
    SELECT 1 FROM members
    WHERE id = OLD.member_id AND username = 'admin'
  ) THEN
    RAISE EXCEPTION 'The system admin role cannot be removed';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_system_admin_role
BEFORE UPDATE OR DELETE ON member_roles
FOR EACH ROW EXECUTE FUNCTION protect_system_admin_role();
