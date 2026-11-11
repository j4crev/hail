-- Provider-local identity bindings never travel with an account transfer.
CREATE TABLE account_provider_identities (
  id uuid PRIMARY KEY,
  integration text NOT NULL,
  issuer text NOT NULL,
  tenant text NOT NULL,
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES provider_accounts(id),
  serving_generation bigint NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes)='array'),
  disabled_at timestamptz,
  UNIQUE (integration, issuer, tenant, subject)
);
CREATE TABLE account_provider_sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  identity_id uuid NOT NULL REFERENCES account_provider_identities(id),
  upstream_session text NOT NULL,
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CHECK (expires_at>authenticated_at)
);
CREATE INDEX account_provider_sessions_identity ON account_provider_sessions(identity_id);
