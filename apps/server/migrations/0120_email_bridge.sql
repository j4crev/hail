-- Reference-provider inbound email bridge: per-subscription aliases and the
-- intake queue. Provider-local policy state, excluded from account transfer.

CREATE TABLE email_bridge_aliases (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  -- Sixty random bits. A deleted alias keeps its row so the address is never reissued.
  local_part text NOT NULL UNIQUE CHECK (local_part ~ '^[a-z2-7]{12}$'),
  label text NOT NULL CHECK (octet_length(label) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  last_received_at timestamptz,
  message_count bigint NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE INDEX email_bridge_aliases_account ON email_bridge_aliases(account_id, created_at) WHERE state <> 'deleted';

CREATE TABLE email_bridge_intake (
  id uuid PRIMARY KEY,
  alias_id uuid NOT NULL REFERENCES email_bridge_aliases(id) ON DELETE CASCADE,
  -- Message-ID when present, otherwise the message bytes; see spec/email-bridge.md.
  dedupe_digest bytea NOT NULL CHECK (octet_length(dedupe_digest) = 32),
  size integer NOT NULL CHECK (size > 0),
  envelope_sender text CHECK (octet_length(envelope_sender) <= 320),
  source_address inet,
  received_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','converting','converted','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The original message exists only until it is converted or abandoned.
  raw bytea,
  converted_body bytea,
  diagnostics jsonb,
  failure text CHECK (octet_length(failure) <= 500),
  UNIQUE (alias_id, dedupe_digest),
  CHECK ((raw IS NOT NULL) = (state IN ('queued','converting'))),
  CHECK (raw IS NULL OR octet_length(raw) = size),
  CHECK ((converted_body IS NOT NULL) = (state = 'converted'))
);
CREATE INDEX email_bridge_intake_work ON email_bridge_intake(next_attempt_at) WHERE state IN ('queued','converted');
CREATE INDEX email_bridge_intake_recent ON email_bridge_intake(alias_id, accepted_at);
