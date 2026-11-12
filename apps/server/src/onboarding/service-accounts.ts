import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog, type DocumentData, type Operation } from "@did-plc/lib";
import { createWebCryptoSigner, encodeBase64Url, signPayload } from "@racrproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import type { SQL } from "bun";
import { tokenHash } from "../accounts/repository.js";
import { canonicalizeHailAddress } from "../identity/address.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountKeys, importEd25519PrivateKey } from "../identity/keys.js";
import { requireFreshPublicAuthority } from "../plc/authority.js";
import type { PlcDirectoryClient } from "../plc/client.js";
import { isPlcNotFound } from "../plc/client.js";
import type { HailDidResolver } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import { verifyRegisteredGenesis } from "../plc/verify.js";
import type { AddressVerificationService } from "./activation.js";
import { OnboardingRepository } from "./repository.js";

/** Custody profile for provider-owned reserved addresses (spec/provider-service-accounts.md). */
export const PROVIDER_SERVICE_PROFILE_VERSION = "hail-provider-service-v1";
/** v1 enrolls passkeys, and grants operator access, only for this service account. */
export const OPERATOR_SERVICE_LOCAL_PART = "admin";

export class ServiceAccountError extends Error {}

interface PreparationRow {
  account_id: string; provider_recovery_public_key: string; provider_rotation_public_key: string;
  provider_identity_public_key: string; provider_messaging_public_key: string; initial_binding_cose: Uint8Array | null;
}

export interface ServiceAccountSummary {
  address: string; accountId: string; did: string | null; state: string;
  active: boolean; operator: boolean; passkeys: number;
}

export class ProviderServiceAccounts {
  constructor(private readonly sql: SQL, private readonly plc: PlcDirectoryClient,
    private readonly resolver: HailDidResolver, private readonly encryptor: KeyEncryptor,
    registryOrigin: string, private readonly serviceBase: string, private readonly verifier: AddressVerificationService,
    private readonly nativeDomain = new URL(serviceBase).hostname, private readonly publicOrigin = new URL(serviceBase).origin) {
    if (registryOrigin !== "https://plc.directory" || serviceBase !== `${new URL(serviceBase).origin}/hail`) {
      throw new ServiceAccountError("Service accounts require canonical public PLC and provider Hail services");
    }
  }

  async recoveryKey(): Promise<string | null> {
    return (await this.sql<{ public_key: string }[]>`SELECT public_key FROM provider_service_recovery`)[0]?.public_key ?? null;
  }

  /** Records the offline provider recovery public key once. Repeating the same key is a no-op. */
  async setRecoveryKey(publicKey: string): Promise<void> {
    let algorithm: string;
    try { algorithm = parseDidKey(publicKey).jwtAlg; } catch { throw new ServiceAccountError("Use a public did:key, not a private key"); }
    if (![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(algorithm)) {
      throw new ServiceAccountError("The provider recovery key must be a P-256 or secp256k1 public did:key");
    }
    await this.sql`INSERT INTO provider_service_recovery (public_key) VALUES (${publicKey}) ON CONFLICT (singleton) DO NOTHING`;
    if (await this.recoveryKey() !== publicKey) throw new ServiceAccountError("A different provider recovery key is already set");
  }

  /** Creates, or resumes creating, the service account for a reserved local part. */
  async create(localPart: string): Promise<ServiceAccountSummary> {
    const address = this.address(localPart);
    if (!(await this.sql`SELECT 1 FROM provider_reserved_names WHERE local_part=${address.split("@")[0]!}`).length) {
      throw new ServiceAccountError("Only reserved provider names can be service accounts");
    }
    const accountId = await this.prepare(address);
    await this.register(accountId);
    await this.activate(accountId);
    return (await this.list()).find(row => row.accountId === accountId)!;
  }

  async list(): Promise<ServiceAccountSummary[]> {
    const rows = await this.sql<{ id: string; canonical_address: string; did: string | null; onboarding_state: string;
      active: boolean; operator: boolean; passkeys: number }[]>`
      SELECT account.id, account.canonical_address, account.did, account.onboarding_state,
        evidence.account_id IS NOT NULL AND account.onboarding_state='active' AS active,
        EXISTS (SELECT 1 FROM provider_operators op JOIN account_serving_generations g
          ON g.account_id=op.account_id AND g.generation=op.serving_generation WHERE op.account_id=account.id) AS operator,
        (SELECT count(*)::integer FROM account_passkeys key WHERE key.account_id=account.id AND key.revoked_at IS NULL) AS passkeys
      FROM provider_service_account_preparations preparation
      JOIN provider_accounts account ON account.id=preparation.account_id
      LEFT JOIN provider_service_account_evidence evidence ON evidence.account_id=account.id
      WHERE account.address_released_at IS NULL ORDER BY account.canonical_address`;
    return rows.map(row => ({ address: row.canonical_address, accountId: row.id, did: row.did,
      state: row.onboarding_state, active: row.active, operator: row.operator, passkeys: row.passkeys }));
  }

  /** Reserved names on the native domain that no unreleased account holds yet. */
  async available(): Promise<string[]> {
    const rows = await this.sql<{ local_part: string }[]>`SELECT reserved.local_part FROM provider_reserved_names reserved
      WHERE NOT EXISTS (SELECT 1 FROM provider_accounts account WHERE account.address_released_at IS NULL
        AND account.canonical_address = reserved.local_part || '@' || ${this.nativeDomain})
      ORDER BY reserved.local_part`;
    return rows.map(row => row.local_part);
  }

  /**
   * Issues a single-use, ten-minute passkey enrollment link. Host access already
   * controls every provider key, so this grants no new authority.
   */
  async passkeyLink(localPart: string): Promise<{ address: string; url: string; expiresAt: string }> {
    const address = this.address(localPart);
    if (address.split("@")[0] !== OPERATOR_SERVICE_LOCAL_PART) {
      throw new ServiceAccountError("Passkey login is available only for the admin service account");
    }
    const token = `racr_${encodeBase64Url(new Uint8Array(randomBytes(32)))}`;
    const created = await this.sql<{ expires_at: Date }[]>`
      INSERT INTO account_passkey_enrollment_capabilities (id, token_hash, account_id, serving_generation, expires_at)
      SELECT ${randomUUID()}, ${tokenHash(token)}, account.id, generation.generation, clock_timestamp()+interval '10 minutes'
      FROM provider_accounts account
      JOIN provider_service_account_evidence evidence ON evidence.account_id=account.id
      JOIN account_serving_generations generation ON generation.account_id=account.id
      LEFT JOIN provider_migration_fences fence ON fence.account_id=account.id
      WHERE account.canonical_address=${address} AND account.address_released_at IS NULL AND account.closed_at IS NULL
        AND account.onboarding_state='active' AND fence.account_id IS NULL
      RETURNING expires_at`;
    if (!created[0]) throw new ServiceAccountError("Create the active admin service account first");
    return { address, url: `${this.publicOrigin}/auth/recover#token=${encodeURIComponent(token)}`,
      expiresAt: created[0].expires_at.toISOString() };
  }

  private address(localPart: string): string {
    let address: string;
    try { address = canonicalizeHailAddress(`${localPart}@${this.nativeDomain}`); }
    catch { throw new ServiceAccountError("Invalid service account name"); }
    if (address !== `${localPart}@${this.nativeDomain}`) throw new ServiceAccountError("Use the canonical lowercase name");
    return address;
  }

  /** Keys and the signed genesis are generated once and retained before any submission. */
  private async prepare(address: string): Promise<string> {
    const prior = (await this.sql<{ id: string; prepared: boolean }[]>`
      SELECT account.id, preparation.account_id IS NOT NULL AS prepared FROM provider_accounts account
      LEFT JOIN provider_service_account_preparations preparation ON preparation.account_id=account.id
      WHERE account.canonical_address=${address} AND account.address_released_at IS NULL`)[0];
    if (prior) {
      if (!prior.prepared) throw new ServiceAccountError("Another account holds this address; it was not changed");
      return prior.id;
    }
    const recovery = await this.recoveryKey();
    if (!recovery) throw new ServiceAccountError("Set the provider recovery key before creating service accounts");
    const accountId = randomUUID(), generated = await generateAccountKeys(accountId, this.encryptor);
    const operation = await signOperation({ type: "plc_operation", prev: null,
      rotationKeys: [recovery, generated.rotationDidKey],
      verificationMethods: { "hail-identity": generated.identityDidKey, "hail-messaging": generated.messagingDidKey },
      alsoKnownAs: [], services: { hail: { type: "HailMessaging", endpoint: this.serviceBase } } }, generated.rotationKey);
    const did = await didForCreateOp(operation), operationCid = (await cidForCbor(operation)).toString();
    const state = { did, rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
      alsoKnownAs: operation.alsoKnownAs, services: operation.services };
    if (!isDeepStrictEqual(await validateOperationLog(did, [operation]), state)) throw new ServiceAccountError("Generated genesis is invalid");
    try {
      await this.sql.begin(async tx => {
        await tx`INSERT INTO provider_role_claims (canonical_address, account_id, owner_recovery_public_key)
          VALUES (${address}, ${accountId}, NULL)`;
        await tx`INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
          VALUES (${accountId}, ${randomUUID()}, ${address}, 'reserved')`;
        for (const key of generated.keys) {
          await tx`INSERT INTO account_keys (account_id, role, algorithm, public_key, encrypted_private_key,
            encryption_nonce, encryption_version, kek_id) VALUES (${accountId}, ${key.role}, ${key.algorithm}, ${key.publicKey},
            ${key.ciphertext}, ${key.nonce}, ${key.encryptionVersion}, ${key.kekId})`;
        }
        await tx`INSERT INTO provider_service_account_preparations (account_id, provider_recovery_public_key,
          provider_rotation_public_key, provider_identity_public_key, provider_messaging_public_key)
          VALUES (${accountId}, ${recovery}, ${generated.rotationDidKey}, ${generated.identityDidKey}, ${generated.messagingDidKey})`;
        const changed = await tx`UPDATE provider_accounts SET did=${did}, onboarding_state='prepared',
          state_version=state_version+1, updated_at=clock_timestamp() WHERE id=${accountId} AND did IS NULL
          AND onboarding_state='reserved' RETURNING id`;
        if (changed.length !== 1) throw new ServiceAccountError("Service account preparation changed");
        await tx`INSERT INTO plc_operation_evidence (id, account_id, did, operation_cid, registry_origin,
          signed_operation, signed_operation_bytes, dag_cbor, expected_state, submission_state)
          VALUES (${randomUUID()}, ${accountId}, ${did}, ${operationCid}, 'https://plc.directory',
            ${JSON.stringify(operation)}::jsonb, ${new TextEncoder().encode(JSON.stringify(operation))},
            ${new Uint8Array(dagCbor.encode(operation))}, ${JSON.stringify(state)}::jsonb, 'prepared')`;
      });
    } catch (error) {
      // A concurrent creator won; resume its preparation instead.
      const winner = await this.sql`SELECT 1 FROM provider_service_account_preparations preparation
        JOIN provider_accounts account ON account.id=preparation.account_id WHERE account.canonical_address=${address}`;
      if (winner.length) return this.prepare(address);
      throw error;
    }
    return accountId;
  }

  private async preparation(accountId: string): Promise<PreparationRow> {
    const row = (await this.sql<PreparationRow[]>`SELECT * FROM provider_service_account_preparations WHERE account_id=${accountId}`)[0];
    if (!row) throw new ServiceAccountError("Service account preparation does not exist");
    return row;
  }

  private async register(accountId: string): Promise<void> {
    const prepared = await this.preparation(accountId), repository = new OnboardingRepository(this.sql);
    let account = await repository.getAccount(accountId);
    const genesis = await repository.getGenesis(accountId), did = account.did!;
    const operation = genesis.operation as Operation, dagCborBytes = new Uint8Array(dagCbor.encode(operation));
    const state = { did, rotationKeys: operation.rotationKeys, verificationMethods: operation.verificationMethods,
      alsoKnownAs: operation.alsoKnownAs, services: operation.services };
    if (account.state === "prepared" || account.state === "submission-unknown") {
      const current = await this.plc.getOperationLog(did).catch(error => isPlcNotFound(error) ? null : Promise.reject(error));
      if (current?.[0] && (await cidForCbor(current[0])).toString() !== genesis.operationCid) {
        throw new ServiceAccountError("Service DID has another genesis");
      }
      if (!current?.[0]) {
        if (account.state === "prepared") await repository.beginSubmission(accountId);
        try { await this.plc.sendOperation(did, operation); }
        catch (error) {
          const retry = await this.plc.getOperationLog(did).catch(readError => isPlcNotFound(readError) ? null : Promise.reject(readError));
          if (!retry?.[0] || (await cidForCbor(retry[0])).toString() !== genesis.operationCid) {
            throw new ServiceAccountError("PLC registration is ambiguous; retry to resume the same genesis", { cause: error });
          }
        }
      }
      const readback = await verifyRegisteredGenesis({ client: this.plc, did, cid: genesis.operationCid,
        operation, dagCbor: dagCborBytes, expectedState: state as DocumentData });
      const strict = await this.resolver.resolve(did);
      if (strict.evidence.verification?.operationCid !== genesis.operationCid || strict.identityDidKey !== prepared.provider_identity_public_key ||
        strict.messagingDidKey !== prepared.provider_messaging_public_key || strict.serviceBase !== this.serviceBase) {
        throw new ServiceAccountError("Validated public reader does not confirm the service genesis");
      }
      await repository.markDidRegistered(accountId, readback);
      account = await repository.getAccount(accountId);
    }
    if (account.state === "did-registered") {
      const bindingCose = await this.binding(accountId, account.canonicalAddress, did, prepared);
      await repository.stageAddressBinding({ accountId, bindingId: randomUUID(), address: account.canonicalAddress, did,
        cose: bindingCose, digest: new Uint8Array(createHash("sha256").update(bindingCose).digest()),
        issuedAt: new Date() });
    }
  }

  private async binding(accountId: string, address: string, did: string, prepared: PreparationRow): Promise<Uint8Array> {
    if (prepared.initial_binding_cose) return new Uint8Array(prepared.initial_binding_cose);
    const keyId = `${did}#hail-identity`, key = await new OnboardingRepository(this.sql).getKey(accountId, "hail-identity");
    const secret = await this.encryptor.decrypt(accountId, key.role, key.algorithm, key.publicKey, key);
    let cose: Uint8Array;
    try {
      cose = await signPayload("hail.address-binding", { type: "hail.address-binding", version: 2, address, did,
        issued_at: Math.floor(Date.now() / 1000), key_id: keyId }, createWebCryptoSigner(keyId, await importEd25519PrivateKey(secret)));
    } finally { secret.fill(0); }
    await this.sql`UPDATE provider_service_account_preparations SET initial_binding_cose=${cose}
      WHERE account_id=${accountId} AND initial_binding_cose IS NULL`;
    return new Uint8Array((await this.preparation(accountId)).initial_binding_cose!);
  }

  private async activate(accountId: string): Promise<void> {
    const prepared = await this.preparation(accountId), repository = new OnboardingRepository(this.sql);
    const account = await repository.getAccount(accountId);
    if (account.state === "active") return;
    if (account.state !== "address-staged") throw new ServiceAccountError(`Service account is ${account.state}; retry creation`);
    const genesis = await repository.getGenesis(accountId), binding = await repository.getBindingForAccount(accountId);
    const expectedState = { did: account.did, rotationKeys: genesis.operation.rotationKeys,
      verificationMethods: genesis.operation.verificationMethods, alsoKnownAs: genesis.operation.alsoKnownAs,
      services: genesis.operation.services } as DocumentData;
    const attemptId = await repository.beginActivation(accountId, binding.id);
    try {
      const verified = await this.verifier.verify(account.canonicalAddress);
      if (verified.did !== account.did || verified.serviceBase !== this.serviceBase ||
        verified.messagingDidKey !== prepared.provider_messaging_public_key ||
        verified.plcEvidence.verification?.operationCid !== genesis.operationCid ||
        !isDeepStrictEqual(verified.plcEvidence.data, expectedState) ||
        !Buffer.from(verified.representation).equals(Buffer.from(binding.cose)) ||
        !Buffer.from(verified.digest).equals(Buffer.from(binding.digest))) {
        throw new ServiceAccountError("Published identity differs from the staged service account");
      }
      await this.sql.begin(async tx => {
        const now = (await tx<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`)[0]!.instant;
        const plcDigest = await requireFreshPublicAuthority(tx, verified.plcEvidence, { did: account.did!,
          role: "hail-messaging", key: prepared.provider_messaging_public_key, serviceBase: this.serviceBase }, now);
        if (!plcDigest) throw new ServiceAccountError("Activation requires strict PLC authority evidence");
        await retainPublicSigningAuthority(tx, { actionType: "address-binding", localAccountId: accountId,
          did: account.did!, role: "hail-identity", key: prepared.provider_identity_public_key,
          serviceBase: this.serviceBase, representation: binding.cose, evidence: verified.plcEvidence });
        await tx`INSERT INTO provider_service_account_evidence (account_id, profile_version,
          provider_recovery_public_key, provider_identity_public_key)
          VALUES (${accountId}, ${PROVIDER_SERVICE_PROFILE_VERSION}, ${prepared.provider_recovery_public_key},
            ${prepared.provider_identity_public_key})`;
        const activated = await tx`UPDATE provider_accounts AS account SET onboarding_state='active', activated_at=${now},
          activation_binding_digest=${binding.digest}, activation_verification_mode='public', activation_attempt_id=NULL,
          state_version=state_version+1, updated_at=${now} FROM address_bindings AS selected
          WHERE account.id=${accountId} AND account.onboarding_state='activating' AND account.activation_attempt_id=${attemptId}
            AND selected.id=${binding.id} AND selected.account_id=account.id AND selected.selected_at IS NOT NULL
            AND selected.representation_digest=${binding.digest} RETURNING account.id`;
        if (activated.length !== 1) throw new ServiceAccountError("Service account cannot be activated");
      });
    } catch (error) {
      await repository.cancelActivation(accountId, binding.id, attemptId);
      throw error;
    }
  }
}
