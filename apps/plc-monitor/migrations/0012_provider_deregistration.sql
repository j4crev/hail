-- A retired registration keeps its history and its identities' records but no longer
-- reserves its origin, so a deregistered or replaced provider can register again
-- (spec/monitor-receiver.md).
ALTER TABLE monitor_enrollment_providers DROP CONSTRAINT monitor_enrollment_providers_provider_origin_key;
CREATE UNIQUE INDEX monitor_enrollment_providers_active_origin
  ON monitor_enrollment_providers(provider_origin) WHERE retired_at IS NULL;
