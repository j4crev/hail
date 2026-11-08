-- Durable cleanup responsibility, committed with closure. Historical alpha
-- closures are included so upgrading also cleans up their orphaned enrollments.
CREATE TABLE account_monitor_cleanup (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id),
  did text NOT NULL,
  operation_cid text NOT NULL,
  monitor_public_key text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz
);
CREATE INDEX account_monitor_cleanup_pending_idx ON account_monitor_cleanup(next_attempt_at,account_id) WHERE completed_at IS NULL;
INSERT INTO account_monitor_cleanup(account_id,did,operation_cid,monitor_public_key)
SELECT a.id,a.did,e.operation_cid,p.monitor_public_key FROM provider_accounts a
JOIN public_onboarding_preparations p ON p.account_id=a.id
JOIN plc_operation_evidence e ON e.account_id=a.id AND e.did=a.did AND e.previous_cid IS NULL
WHERE a.closed_at IS NOT NULL AND p.custody_profile='managed' AND p.monitor_assurance='reduced-assurance-alpha-v1';
