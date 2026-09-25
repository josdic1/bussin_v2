-- A route revision may change stops and display details, but it cannot become a
-- different route family/service period or skip revision numbers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM routes child
      JOIN routes parent ON parent.id = child.supersedes_route_id
     WHERE child.route_family_id IS DISTINCT FROM parent.route_family_id
        OR child.service_period IS DISTINCT FROM parent.service_period
        OR child.revision <> parent.revision + 1
  ) THEN
    RAISE EXCEPTION 'Existing route revisions violate route identity';
  END IF;

  IF EXISTS (
    SELECT 1 FROM routes
     WHERE supersedes_route_id IS NULL AND revision <> 1
  ) THEN
    RAISE EXCEPTION 'A root route must start at revision 1';
  END IF;
END $$;

CREATE FUNCTION enforce_route_revision_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_family_id uuid;
  parent_service_period text;
  parent_revision integer;
BEGIN
  IF NEW.supersedes_route_id IS NULL THEN
    IF NEW.revision <> 1 THEN
      RAISE EXCEPTION 'A root route must start at revision 1';
    END IF;
    RETURN NEW;
  END IF;

  SELECT route_family_id, service_period, revision
    INTO parent_family_id, parent_service_period, parent_revision
    FROM routes
   WHERE id = NEW.supersedes_route_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The superseded route does not exist';
  END IF;

  IF NEW.route_family_id IS DISTINCT FROM parent_family_id
     OR NEW.service_period IS DISTINCT FROM parent_service_period THEN
    RAISE EXCEPTION 'A route revision cannot change route family or service period';
  END IF;

  IF NEW.revision <> parent_revision + 1 THEN
    RAISE EXCEPTION 'A route revision must increment by exactly one';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_route_revision_identity
BEFORE INSERT OR UPDATE OF route_family_id, service_period, revision, supersedes_route_id
ON routes
FOR EACH ROW EXECUTE FUNCTION enforce_route_revision_identity();
