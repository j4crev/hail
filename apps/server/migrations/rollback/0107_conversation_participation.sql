-- Revival records discarded by the upgrade cannot be recovered by SQL rollback.
DO $$ BEGIN
  RAISE EXCEPTION 'Conversation participation upgrade is irreversible; restore a pre-upgrade backup to roll back';
END $$;
