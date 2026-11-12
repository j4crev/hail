-- Run only after rolling back application code that delivers bridged mail.
BEGIN;
ALTER TABLE email_bridge_intake DROP COLUMN message_id;
DELETE FROM schema_migrations WHERE version = 122;
COMMIT;
