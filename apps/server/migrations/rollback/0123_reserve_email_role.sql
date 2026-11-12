BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM provider_role_claims WHERE split_part(canonical_address, '@', 1) = 'email') THEN
    RAISE EXCEPTION 'Cannot release the email role name after the operator claimed it';
  END IF;
END; $$;
DELETE FROM provider_reserved_names WHERE local_part = 'email';
DELETE FROM schema_migrations WHERE version = 123;
COMMIT;
