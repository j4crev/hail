-- Run only after rolling back 0122 and the application code that uses aliases.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM email_bridge_aliases) THEN
    RAISE EXCEPTION 'Cannot roll back the email bridge after users created aliases';
  END IF;
END; $$;
DROP TABLE email_bridge_intake;
DROP TABLE email_bridge_aliases;
DELETE FROM schema_migrations WHERE version = 120;
COMMIT;
