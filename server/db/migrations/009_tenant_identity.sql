-- Every deployment has its own database. Claim its identity once before use.
CREATE TABLE tenant_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tenant_key text NOT NULL UNIQUE CHECK (tenant_key ~ '^[a-z][a-z0-9-]{1,39}$'),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION prevent_tenant_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Database tenant identity is immutable';
END;
$$;

CREATE TRIGGER tenant_identity_immutable
BEFORE UPDATE OR DELETE ON tenant_identity
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_identity_change();
