-- Registration v2 (spec/monitor-receiver.md): one shared receiver, a verified
-- operator contact and a separate receiver credential per provider.
ALTER TABLE monitor_enrollment_providers
  ADD COLUMN web_origin text,
  ADD COLUMN operator_email text CHECK (operator_email IS NULL OR length(operator_email) BETWEEN 3 AND 254),
  ADD COLUMN receiver_token_hash text UNIQUE,
  ADD COLUMN receiver_provisioned_at timestamptz;

-- Operator email codes awaiting confirmation. Only the code hash is kept.
CREATE TABLE monitor_provider_registration_codes (
  registration_hash text PRIMARY KEY,
  provider_origin text NOT NULL,
  web_origin text,
  operator_email text NOT NULL CHECK (length(operator_email) BETWEEN 3 AND 254),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
