BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM account_monitor_handoffs) THEN
    RAISE EXCEPTION 'Monitor handoff responsibility prevents rollback';
  END IF;
END $$;
DROP TABLE account_monitor_handoffs;
DROP TABLE account_monitor_bindings;
DELETE FROM schema_migrations WHERE version=108;
COMMIT;
