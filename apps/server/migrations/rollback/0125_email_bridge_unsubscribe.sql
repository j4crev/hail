BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM email_bridge_unsubscriptions WHERE state = 'queued') THEN
    RAISE EXCEPTION 'Pending unsubscribe requests would be lost';
  END IF;
  IF EXISTS (SELECT 1 FROM email_bridge_deletions) THEN
    RAISE EXCEPTION 'Permanent edge deletion records would be lost';
  END IF;
END $$;
DROP TABLE email_bridge_unsubscriptions;
DROP TABLE email_bridge_deletions;
DELETE FROM schema_migrations WHERE version = 125;
COMMIT;
