BEGIN;
ALTER TABLE jmap_push_subscriptions DROP COLUMN verification_error;
DELETE FROM schema_migrations WHERE version=119;
COMMIT;
