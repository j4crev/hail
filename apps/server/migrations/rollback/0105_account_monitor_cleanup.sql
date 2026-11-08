BEGIN;
LOCK TABLE account_monitor_cleanup IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM account_monitor_cleanup) OR
     EXISTS (SELECT 1 FROM schema_migrations WHERE version > 105) THEN
    RAISE EXCEPTION 'Account monitoring cleanup responsibility prevents rollback' USING ERRCODE = '55000';
  END IF;
END $$;
DROP TABLE account_monitor_cleanup;
DELETE FROM schema_migrations WHERE version = 105;
COMMIT;
