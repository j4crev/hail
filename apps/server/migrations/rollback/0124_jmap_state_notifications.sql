BEGIN;
-- Streams fall back to polling; no data depends on these triggers.
DROP TRIGGER IF EXISTS jmap_message_states_notify ON jmap_message_states;
DROP TRIGGER IF EXISTS jmap_draft_states_notify ON jmap_draft_states;
DROP TRIGGER IF EXISTS jmap_collection_states_notify ON jmap_collection_states;
DROP FUNCTION IF EXISTS hail_notify_jmap_state();
DELETE FROM schema_migrations WHERE version = 124;
COMMIT;
