BEGIN;
-- Only discard provider-local synchronization projections. Signed domain
-- history, submission intent, relationships and mailbox dispositions survive.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['account_publications','publication_targets','connection_message_batches','connection_message_targets',
  'account_sent_dispositions','federated_connection_pairs','account_serving_generations','connection_unseen','connection_invitations','federated_connection_attempts','account_conversation_preferences','connection_conversation_preferences','conversation_memberships','sent_envelopes','detached_bodies',
  'sent_delivery_status','grant_lineages','grant_revisions','collocated_grant_receivers'] LOOP
  EXECUTE format('DROP TRIGGER jmap_dirty ON %I',t);
 END LOOP;
END $$;
DROP TRIGGER jmap_dirty_receivers ON grant_lineages;
DROP TRIGGER jmap_flush_dirty ON jmap_dirty_accounts;
DROP FUNCTION hail_jmap_flush_dirty();
DROP FUNCTION hail_jmap_dirty();
DROP FUNCTION hail_jmap_refresh(uuid);
DROP TABLE jmap_collection_changes;
DROP TABLE jmap_objects;
DROP TABLE jmap_collection_states;
DROP TABLE jmap_dirty_accounts;
DROP VIEW jmap_live_objects;
DROP FUNCTION hail_jmap_b64(bytea);
DELETE FROM schema_migrations WHERE version=116;
COMMIT;
