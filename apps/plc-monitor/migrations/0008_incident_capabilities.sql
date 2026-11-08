-- Email possession authorizes only the incident identified by this row.
CREATE TABLE monitor_incident_capabilities (
  alert_id uuid PRIMARY KEY REFERENCES monitor_alerts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  renewed_at timestamptz
);
CREATE TABLE monitor_incident_sessions (
  token_hash text PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES monitor_incident_capabilities(alert_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX monitor_incident_sessions_expiry ON monitor_incident_sessions(expires_at);
-- Mailbox approval is deliberately separate from independent local-owner evidence.
CREATE TABLE monitor_incident_approvals (
  did text NOT NULL REFERENCES monitored_dids(did) ON DELETE RESTRICT,
  operation_cid text NOT NULL,
  previous_expected_cid text NOT NULL,
  approved_state jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  alert_id uuid NOT NULL REFERENCES monitor_alerts(id) ON DELETE RESTRICT,
  PRIMARY KEY (did, operation_cid)
);
CREATE TABLE monitor_recoveries (
  alert_id uuid PRIMARY KEY REFERENCES monitor_alerts(id) ON DELETE RESTRICT,
  reviewed_current_cid text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('restore','protect')),
  operation jsonb NOT NULL,
  operation_cid text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz
);
