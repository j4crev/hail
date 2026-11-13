BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM monitor_enrollment_providers GROUP BY provider_origin HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'An origin has several registrations; resolve them before rolling back';
  END IF;
END $$;
DROP INDEX monitor_enrollment_providers_active_origin;
ALTER TABLE monitor_enrollment_providers
  ADD CONSTRAINT monitor_enrollment_providers_provider_origin_key UNIQUE (provider_origin);
DELETE FROM schema_migrations WHERE version=12;
COMMIT;
