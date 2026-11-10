BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM monitor_management_handoffs) OR
     EXISTS(SELECT 1 FROM monitor_enrollment_providers WHERE retired_at IS NOT NULL) OR
     EXISTS(SELECT 1 FROM monitor_receiver_cleanup WHERE completed_at IS NULL) THEN
    RAISE EXCEPTION 'Lifecycle authority or cleanup responsibility prevents rollback';
  END IF;
END $$;
DROP TABLE monitor_receiver_cleanup;
DROP TABLE monitor_management_handoffs;
ALTER TABLE monitor_enrollment_providers DROP COLUMN retired_at;
ALTER TABLE monitored_dids DROP COLUMN management_cid;
DELETE FROM schema_migrations WHERE version=10;
COMMIT;
