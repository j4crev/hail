BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM jmap_uploads WHERE expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Unexpired JMAP uploads prevent rollback';
  END IF;
END $$;
DROP TABLE jmap_uploads;
DELETE FROM schema_migrations WHERE version=115;
COMMIT;
