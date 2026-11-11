BEGIN;
-- Reapplying would allocate different JMAP record IDs for the same account epoch.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM jmap_messages) THEN
    RAISE EXCEPTION 'JMAP identities prevent rollback; an explicit account-epoch reset is required';
  END IF;
END $$;
DROP TRIGGER jmap_track_message ON delivered_messages;
DROP TRIGGER jmap_generation ON account_serving_generations;
DROP FUNCTION hail_jmap_track_message();
DROP FUNCTION hail_jmap_generation();
DROP FUNCTION hail_jmap_message_change(uuid,bigint,text,uuid,text);
DROP TABLE jmap_message_changes,jmap_messages,jmap_message_states;
DELETE FROM schema_migrations WHERE version=112;
COMMIT;
