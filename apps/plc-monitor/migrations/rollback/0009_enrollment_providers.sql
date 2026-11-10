BEGIN;
LOCK TABLE monitor_enrollment_providers, monitored_dids IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > 9) OR
     EXISTS (SELECT 1 FROM monitor_enrollment_providers) OR
     EXISTS (SELECT 1 FROM monitored_dids WHERE enrollment_provider_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Provider registration or ownership evidence prevents rollback' USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE monitored_dids DROP COLUMN enrollment_provider_id;
DROP TABLE monitor_enrollment_providers;
DELETE FROM schema_migrations WHERE version = 9;
COMMIT;
