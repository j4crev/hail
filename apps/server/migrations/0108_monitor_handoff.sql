CREATE TABLE account_monitor_bindings (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id), did text NOT NULL,
  operation_cid text NOT NULL, monitor_public_key text NOT NULL,
  serving_generation bigint NOT NULL CHECK(serving_generation>0)
);
INSERT INTO account_monitor_bindings(account_id,did,operation_cid,monitor_public_key,serving_generation)
SELECT a.id,a.did,e.operation_cid,p.monitor_public_key,g.generation FROM provider_accounts a
JOIN public_onboarding_preparations p ON p.account_id=a.id
JOIN account_serving_generations g ON g.account_id=a.id
JOIN plc_operation_evidence e ON e.account_id=a.id AND e.did=a.did AND e.previous_cid IS NULL
WHERE p.custody_profile='managed' AND p.monitor_assurance='reduced-assurance-alpha-v1' AND g.generation=1;
CREATE TABLE account_monitor_handoffs (
  transfer_id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES provider_accounts(id),
  serving_generation bigint NOT NULL, did text NOT NULL, operation_cid text NOT NULL,
  monitor_public_key text NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0, completed_at timestamptz,
  outcome text CHECK(outcome IN ('managed','independent','superseded'))
);
