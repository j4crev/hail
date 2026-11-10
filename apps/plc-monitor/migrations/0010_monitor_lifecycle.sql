-- Management authority changes independently of trusted PLC expectations.
ALTER TABLE monitored_dids ADD COLUMN management_cid text;
UPDATE monitored_dids w SET management_cid=b.operation_cid
FROM monitor_bootstrap_checkpoints b WHERE b.did=w.did AND w.enrollment_provider_id IS NOT NULL;
ALTER TABLE monitor_enrollment_providers ADD COLUMN retired_at timestamptz;
CREATE TABLE monitor_management_handoffs (
  transfer_id uuid PRIMARY KEY, did text NOT NULL REFERENCES monitored_dids(did),
  from_provider uuid NOT NULL REFERENCES monitor_enrollment_providers(id),
  to_provider uuid NOT NULL REFERENCES monitor_enrollment_providers(id),
  operation_cid text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(did,operation_cid)
);
CREATE TABLE monitor_receiver_cleanup (
  did text PRIMARY KEY REFERENCES monitored_dids(did),
  operation_cid text NOT NULL, receiver_url text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz
);
INSERT INTO monitor_receiver_cleanup(did,operation_cid,receiver_url)
SELECT w.did,b.operation_cid,w.alert_webhook_url FROM monitored_dids w
JOIN monitor_bootstrap_checkpoints b ON b.did=w.did
WHERE w.stopped_at IS NOT NULL AND w.enrollment_provider_id IS NOT NULL;
