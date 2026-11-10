-- Credentials authorize a provider's enrollments, never identities belonging to
-- another provider. Existing manually enrolled DIDs retain their authority.
CREATE TABLE monitor_enrollment_providers (
  id uuid PRIMARY KEY,
  provider_origin text NOT NULL UNIQUE,
  alert_origin text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  registration_hash text,
  enabled boolean NOT NULL DEFAULT true,
  requests_per_minute integer NOT NULL DEFAULT 60 CHECK (requests_per_minute BETWEEN 1 AND 600),
  max_identities integer NOT NULL DEFAULT 100 CHECK (max_identities BETWEEN 1 AND 100000),
  enrollments_per_day integer NOT NULL DEFAULT 20 CHECK (enrollments_per_day BETWEEN 1 AND 10000),
  request_window timestamptz,
  request_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE monitored_dids ADD COLUMN enrollment_provider_id uuid
  REFERENCES monitor_enrollment_providers(id) ON DELETE RESTRICT;
CREATE INDEX monitored_dids_provider ON monitored_dids(enrollment_provider_id);
