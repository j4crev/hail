BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM jmap_push_subscriptions WHERE expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Remove active push subscriptions before rollback';
 END IF;
END $$;
DROP TABLE jmap_push_subscriptions,jmap_push_registration_limits;
DELETE FROM schema_migrations WHERE version=118;
COMMIT;
