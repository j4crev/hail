BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM provider_service_account_preparations)
    OR EXISTS (SELECT 1 FROM provider_service_recovery)
    OR EXISTS (SELECT 1 FROM provider_role_claims WHERE owner_recovery_public_key IS NULL) THEN
    RAISE EXCEPTION 'Provider service accounts exist; retire them before rolling back';
  END IF;
END; $$;
ALTER TABLE provider_role_claims ALTER COLUMN owner_recovery_public_key SET NOT NULL;
DROP TRIGGER _provider_service_no_custody_transition ON custody_transition_preparations;
DROP TRIGGER _provider_service_no_fence ON provider_migration_fences;
DROP TRIGGER _provider_service_no_transfer ON provider_transfer_authorizations;
DROP FUNCTION hail_refuse_provider_service_move();
DROP TABLE provider_service_account_evidence;
DROP TABLE provider_service_account_preparations;
DROP TABLE provider_service_recovery;
DROP FUNCTION hail_freeze_provider_service_recovery();
DELETE FROM schema_migrations WHERE version = 126;
COMMIT;
