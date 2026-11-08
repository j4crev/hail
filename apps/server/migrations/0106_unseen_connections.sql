-- Provider-local presentation state; existing and reconstructed connections start seen.
CREATE TABLE connection_unseen (
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  pair_id uuid NOT NULL REFERENCES federated_connection_pairs(id) ON DELETE CASCADE,
  serving_generation bigint NOT NULL CHECK(serving_generation>0),
  connection_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK(epoch>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz,
  PRIMARY KEY(account_id,connection_id,epoch)
);
CREATE INDEX connection_unseen_pending ON connection_unseen(account_id) WHERE seen_at IS NULL;
CREATE TRIGGER hail_fence_connection_unseen BEFORE INSERT OR UPDATE OR DELETE ON connection_unseen
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');
