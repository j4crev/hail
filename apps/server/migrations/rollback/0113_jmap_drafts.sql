BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM jmap_drafts) THEN
    RAISE EXCEPTION 'JMAP draft identities prevent rollback; an explicit account-epoch reset is required';
  END IF;
END $$;
DROP TRIGGER jmap_track_draft ON account_message_drafts;
DROP TRIGGER jmap_draft_generation ON account_serving_generations;
DROP FUNCTION hail_jmap_track_draft();
DROP FUNCTION hail_jmap_draft_generation();
DROP FUNCTION hail_jmap_draft_change(uuid,bigint,uuid,text);
DROP TABLE jmap_draft_changes,jmap_drafts,jmap_draft_states;
DELETE FROM schema_migrations WHERE version=113;
COMMIT;
