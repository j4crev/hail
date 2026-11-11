-- Unreferenced Core uploads are provider-local, quota bounded and expire after 24 hours.
CREATE TABLE jmap_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  bytes bytea NOT NULL CHECK(octet_length(bytes)<=26214400),
  media_type text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours'
);
CREATE INDEX jmap_uploads_owner ON jmap_uploads(account_id,generation,expires_at);
CREATE TRIGGER hail_fence_jmap_uploads BEFORE INSERT OR UPDATE ON jmap_uploads
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');

-- Expired, unreferenced bytes may be reclaimed even after source cutover.
CREATE INDEX jmap_uploads_expiry ON jmap_uploads(expires_at);
