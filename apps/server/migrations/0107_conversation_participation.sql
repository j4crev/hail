-- Remove obsolete revival machinery; message history and participation remain.
DROP TRIGGER conversation_revival_before_fence ON provider_migration_fences;
DROP TRIGGER conversation_revival_before_generation ON account_serving_generations;
DROP FUNCTION hail_conversation_cutover_guard();
DROP TABLE conversation_revival_targets;
DROP TABLE conversation_revival_batches;
DROP TABLE conversation_revival_receipts;
DROP FUNCTION hail_conversation_revival_immutable();

ALTER TABLE conversation_memberships ALTER COLUMN expires_at SET DEFAULT clock_timestamp()+interval '90 days';
-- Existing activity included opens. Conservatively retain its last recorded
-- instant as the upgrade anchor, but never extend an existing deadline.
UPDATE conversation_memberships
SET expires_at=LEAST(expires_at,COALESCE(last_activity_at,admitted_at)+interval '90 days');
