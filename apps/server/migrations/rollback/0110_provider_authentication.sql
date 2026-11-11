BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM account_provider_identities) THEN
    RAISE EXCEPTION 'Provider identity bindings prevent rollback; preserve identity and revocation records';
  END IF;
END $$;
DROP TABLE account_provider_sessions;
DROP TABLE account_provider_identities;
DELETE FROM schema_migrations WHERE version=110;
COMMIT;
