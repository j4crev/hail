-- Device/credential-local notification destinations; never account history.
CREATE TABLE jmap_push_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
 credential_id uuid NOT NULL,
 credential_kind text NOT NULL CHECK(credential_kind IN ('api','passkey','provider')),
 generation bigint NOT NULL,
 scopes jsonb NOT NULL,
 device_client_id text NOT NULL,
 endpoint text NOT NULL,
 keys jsonb NOT NULL,
 types jsonb NOT NULL,
 verification_code text NOT NULL,
 verified_at timestamptz,
 verification_sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempts integer NOT NULL DEFAULT 0,
 last_states jsonb NOT NULL DEFAULT '{}',
 lease_token uuid,
 lease_until timestamptz,
 UNIQUE(credential_kind,credential_id,device_client_id)
);
CREATE INDEX jmap_push_due ON jmap_push_subscriptions(next_attempt_at);
CREATE INDEX jmap_push_owner ON jmap_push_subscriptions(account_id);
CREATE TABLE jmap_push_registration_limits (
 account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
 window_start timestamptz NOT NULL DEFAULT clock_timestamp(),
 registrations integer NOT NULL DEFAULT 0
);
