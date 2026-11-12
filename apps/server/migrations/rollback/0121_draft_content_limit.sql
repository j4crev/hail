-- Run only after rolling back application code that writes drafts over the old limit.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM account_message_drafts WHERE octet_length(content::text) > 400000) THEN
    RAISE EXCEPTION 'Drafts larger than the former 400,000-byte limit exist; they would be lost';
  END IF;
END; $$;
ALTER TABLE account_message_drafts DROP CONSTRAINT account_message_drafts_content_check;
ALTER TABLE account_message_drafts ADD CONSTRAINT account_message_drafts_content_check
  CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 400000);
DELETE FROM schema_migrations WHERE version = 121;
COMMIT;
