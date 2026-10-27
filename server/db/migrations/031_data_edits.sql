-- Data mode edits: one row per cell changed in the Data grid. Who, when, what, before and after.
-- Append-only: rows can't be changed or deleted one by one (the Danger zone reset uses TRUNCATE).
-- member_id has no foreign key so the history survives when a staff login is removed.
CREATE TABLE data_edits (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  member_id uuid NOT NULL,
  member_name text NOT NULL,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  column_name text NOT NULL,
  old_value text,
  new_value text
);

CREATE INDEX data_edits_at_idx ON data_edits (at DESC);

CREATE FUNCTION data_edits_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'data_edits is append-only';
END;
$$;

CREATE TRIGGER data_edits_no_change
BEFORE UPDATE OR DELETE ON data_edits
FOR EACH ROW EXECUTE FUNCTION data_edits_append_only();
