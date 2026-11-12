-- Drafts store bundled images inline as base64url. A body at the protocol's
-- 1 MiB ceiling is about 1.4 million JSON bytes, so the former 400,000-byte
-- limit could not hold what the message format allows.
DO $$
DECLARE existing text;
BEGIN
  SELECT conname INTO STRICT existing FROM pg_constraint
  WHERE conrelid = 'account_message_drafts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%400000%';
  EXECUTE format('ALTER TABLE account_message_drafts DROP CONSTRAINT %I', existing);
END $$;
ALTER TABLE account_message_drafts ADD CONSTRAINT account_message_drafts_content_check
  CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 1500000);
