-- Reports people build themselves on the Reports page (Build your own).
-- The definition is the builder's settings: which data, columns, filters, totals, sort.
-- Dates are not saved; a saved report runs for whatever period is picked.
CREATE TABLE saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  definition jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX saved_reports_name_unique ON saved_reports (lower(trim(name)));
