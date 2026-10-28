-- One format for every phone and email already in the database, matching what the
-- app now enforces on every entry: US phones as 973-555-0123, emails lowercase.
-- Phones that aren't 10-digit US numbers are left exactly as they are.

CREATE FUNCTION pg_temp.us_phone(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN raw IS NULL THEN NULL
    WHEN length(regexp_replace(raw, '\D', '', 'g')) = 10
      THEN regexp_replace(regexp_replace(raw, '\D', '', 'g'), '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3')
    WHEN length(regexp_replace(raw, '\D', '', 'g')) = 11 AND regexp_replace(raw, '\D', '', 'g') LIKE '1%'
      THEN regexp_replace(substr(regexp_replace(raw, '\D', '', 'g'), 2), '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3')
    ELSE raw
  END
$$;

UPDATE guardians SET phone = pg_temp.us_phone(phone) WHERE phone IS DISTINCT FROM pg_temp.us_phone(phone);
UPDATE drivers SET phone = pg_temp.us_phone(phone) WHERE phone IS DISTINCT FROM pg_temp.us_phone(phone);
UPDATE guardians SET email = lower(trim(email)) WHERE email IS DISTINCT FROM lower(trim(email));

-- One email per parent. The app checks this before saving; the index is the backstop.
-- If two guardians already share an email the index is skipped (the app check still
-- applies to every new save) and the deploy log names them so they can be fixed.
DO $$
DECLARE
  shared text;
BEGIN
  SELECT string_agg(email || ' (' || n || ' guardians)', ', ') INTO shared
    FROM (SELECT email, count(*) AS n FROM guardians WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1) d;
  IF shared IS NULL THEN
    CREATE UNIQUE INDEX guardians_email_unique ON guardians (lower(email)) WHERE email IS NOT NULL;
  ELSE
    RAISE NOTICE 'Guardians share these emails, so the unique email index was not created yet: %', shared;
  END IF;
END
$$;
