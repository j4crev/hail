-- Provider service accounts (spec/provider-service-accounts.md, hail-provider-service-v1):
-- reserved provider addresses whose every key is provider-held, except one offline
-- provider recovery key that has the highest PLC rotation priority.

-- The provider recovery public key. Every service DID lists it first, so it is set
-- once and never changed or removed.
CREATE TABLE provider_service_recovery (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  public_key text NOT NULL CHECK (public_key ~ '^did:key:z[1-9A-HJ-NP-Za-km-z]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hail_freeze_provider_service_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The provider recovery key cannot be changed or removed' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER provider_service_recovery_frozen BEFORE UPDATE OR DELETE ON provider_service_recovery
  FOR EACH ROW EXECUTE FUNCTION hail_freeze_provider_service_recovery();

-- Retained creation inputs, so a retry resumes the same keys and signed genesis.
CREATE TABLE provider_service_account_preparations (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  provider_recovery_public_key text NOT NULL,
  provider_rotation_public_key text NOT NULL,
  provider_identity_public_key text NOT NULL,
  provider_messaging_public_key text NOT NULL,
  initial_binding_cose bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (provider_recovery_public_key <> provider_rotation_public_key AND
    provider_identity_public_key <> provider_messaging_public_key)
);

CREATE TABLE provider_service_account_evidence (
  account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  profile_version text NOT NULL CHECK (profile_version = 'hail-provider-service-v1'),
  provider_recovery_public_key text NOT NULL,
  provider_identity_public_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER hail_fence_provider_service_custody BEFORE INSERT OR UPDATE OR DELETE ON provider_service_account_evidence
  FOR EACH ROW EXECUTE FUNCTION hail_guard_did_write('account','account_id');

-- Reserved names are now claimed only by the service-account path, which records no
-- owner key. Existing owner-key claims (pre-launch role accounts) stay valid.
ALTER TABLE provider_role_claims ALTER COLUMN owner_recovery_public_key DROP NOT NULL;

-- Service accounts are bound to their provider: no owner exists to authorize a
-- transfer, fence or custody change, so refuse them before any such state exists.
-- BEFORE triggers fire in name order; the leading underscore makes this refusal first.
CREATE FUNCTION hail_refuse_provider_service_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_service_account_preparations preparation
    JOIN provider_accounts account ON account.id = preparation.account_id WHERE account.did = NEW.did) THEN
    RAISE EXCEPTION 'Provider service accounts cannot transfer or change custody' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER _provider_service_no_transfer BEFORE INSERT OR UPDATE OF did ON provider_transfer_authorizations
  FOR EACH ROW EXECUTE FUNCTION hail_refuse_provider_service_move();
CREATE TRIGGER _provider_service_no_fence BEFORE INSERT OR UPDATE OF did ON provider_migration_fences
  FOR EACH ROW EXECUTE FUNCTION hail_refuse_provider_service_move();
CREATE TRIGGER _provider_service_no_custody_transition BEFORE INSERT OR UPDATE OF did ON custody_transition_preparations
  FOR EACH ROW EXECUTE FUNCTION hail_refuse_provider_service_move();
