-- Database privileges for the email bridge converter (spec/email-bridge.md).
--
-- The converter parses untrusted mail. It may read and update the intake queue
-- and nothing else: no accounts, keys, messages or aliases. Run this as the
-- database owner after the provider has migrated, in the provider's database
-- and schema, then create a login role that is a member of the group role:
--
--   CREATE ROLE email_converter LOGIN PASSWORD '...' IN ROLE hail_email_converter;
--
-- Running it again is harmless.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hail_email_converter') THEN
    CREATE ROLE hail_email_converter NOLOGIN;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO hail_email_converter', current_schema());
END $$;

REVOKE ALL ON email_bridge_intake FROM hail_email_converter;
GRANT SELECT (id, state, attempts, next_attempt_at, received_at, raw) ON email_bridge_intake TO hail_email_converter;
GRANT UPDATE (state, attempts, next_attempt_at, raw, converted_body, diagnostics, failure) ON email_bridge_intake TO hail_email_converter;
