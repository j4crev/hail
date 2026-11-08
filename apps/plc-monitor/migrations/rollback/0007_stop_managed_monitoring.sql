BEGIN;
LOCK TABLE monitored_dids IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM monitored_dids WHERE stopped_at IS NOT NULL) OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version > 7) THEN
    RAISE EXCEPTION 'Stopped monitoring evidence prevents rollback' USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE monitored_dids DROP COLUMN stopped_at;
DELETE FROM schema_migrations WHERE version = 7;
COMMIT;
