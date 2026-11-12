BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM monitor_enrollment_providers WHERE receiver_token_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'Providers hold v2 receiver credentials; retire them before rolling back';
  END IF;
END $$;
DROP TABLE monitor_provider_registration_codes;
ALTER TABLE monitor_enrollment_providers DROP COLUMN receiver_provisioned_at, DROP COLUMN receiver_token_hash,
  DROP COLUMN operator_email, DROP COLUMN web_origin;
DELETE FROM schema_migrations WHERE version=11;
COMMIT;
