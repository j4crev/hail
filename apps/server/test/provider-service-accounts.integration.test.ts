import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { cidForCbor } from "@atproto/common";
import { P256Keypair, verifySignature } from "@atproto/crypto";
import { formatDidDoc, PlcClientError, validateOperationLog, type Operation } from "@did-plc/lib";
import { encodeBase64Url, inspectSignedPayload } from "@racrproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import type { verifyRegistrationResponse } from "@simplewebauthn/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasskeyAuth } from "../src/accounts/passkeys.js";
import { AccountApiRepository } from "../src/accounts/repository.js";
import { ProviderDatabase } from "../src/db/database.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { ProviderServiceAccounts, ServiceAccountError } from "../src/onboarding/service-accounts.js";
import type { PlcDirectoryClient } from "../src/plc/client.js";
import { VerifiedPublicPlcResolver } from "../src/plc/public-resolver.js";
import { PlcHailDidResolver } from "../src/plc/resolver.js";
import { publicEdKey } from "./public-plc-fixture.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const origin = "https://svr.example.org", base = `${origin}/hail`, domain = "example.org";

integration("provider service accounts", () => {
  let admin: SQL, db: ProviderDatabase, schema: string, service: ProviderServiceAccounts, recovery: P256Keypair;
  const logs = new Map<string, Operation[]>();
  const auditCreatedAt = new Date().toISOString();
  let sends = 0, ambiguous = true;
  const plc: PlcDirectoryClient = {
    async health() { return { status: "ok" }; },
    async sendOperation(did, operation) {
      sends++; logs.set(did, [operation]);
      if (ambiguous) { ambiguous = false; throw new Error("lost response"); }
    },
    async getOperationLog(did) { const log = logs.get(did); if (!log) throw new PlcClientError(404, null, "missing"); return log; },
    async getDocumentData(did) { return (await validateOperationLog(did, await this.getOperationLog(did)))!; },
    async getDocument(did) { return formatDidDoc(await this.getDocumentData(did)); },
    async getAuditableLog(did) { return Promise.all((await this.getOperationLog(did)).map(async operation => ({
      did, operation, cid: (await cidForCbor(operation)).toString(), nullified: false, createdAt: auditCreatedAt }))); },
  };
  const reader = (name: string) => ({ origin: `https://reader-${name}.example.com`, operator: `reader-${name}`,
    resolver: new PlcHailDidResolver(plc), audit: (did: string) => plc.getAuditableLog(did),
    health: async () => ({ lastCommittedOpTime: new Date().toISOString() }) });
  const verifyRegistration: typeof verifyRegistrationResponse = async ({ response }) => ({ verified: true, registrationInfo: {
    credential: { id: response.id, publicKey: randomBytes(64), counter: 0, transports: [] }, credentialDeviceType: "multiDevice",
    credentialBackedUp: true, fmt: "none", aaguid: "00000000-0000-0000-0000-000000000000", credentialType: "public-key",
    attestationObject: new Uint8Array(), userVerified: true, credentialBackedUpStatus: false, origin, rpID: "svr.example.org" } });

  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!); schema = `service_accounts_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new ProviderDatabase(url.toString()); await db.migrate();
    const resolver = new VerifiedPublicPlcResolver(db.sql, [reader("one"), reader("two")], ["provider"], [origin]);
    const repository = new OnboardingRepository(db.sql);
    const verifier = { async verify(address: string) {
      const account = await repository.getAccountByAddress(address), binding = await repository.getBindingForAccount(account.id);
      const resolved = await resolver.resolve(account.did!);
      return { address, did: account.did!, serviceBase: resolved.serviceBase, identityDidKey: resolved.identityDidKey,
        messagingDidKey: resolved.messagingDidKey, plcEvidence: resolved.evidence, verifiedAt: new Date(),
        binding: inspectSignedPayload("hail.address-binding", binding.cose).payload, representation: binding.cose, digest: binding.digest };
    } };
    service = new ProviderServiceAccounts(db.sql, plc, resolver, new KeyEncryptor(encodeBase64Url(randomBytes(32))),
      "https://plc.directory", base, verifier, domain, origin);
    recovery = await P256Keypair.create();
  });
  afterAll(async () => {
    if (db) await db.close();
    if (admin) { await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
  });

  it("requires one immutable P-256/secp256k1 provider recovery key before creating accounts", async () => {
    await expect(service.create("admin")).rejects.toThrow("Set the provider recovery key");
    await expect(service.setRecoveryKey((await publicEdKey()).didKey)).rejects.toThrow(ServiceAccountError);
    await expect(service.setRecoveryKey("not-a-key")).rejects.toThrow("public did:key");
    await service.setRecoveryKey(recovery.did());
    await service.setRecoveryKey(recovery.did());
    await expect(service.setRecoveryKey((await P256Keypair.create()).did())).rejects.toThrow("already set");
    await expect(db.sql`UPDATE provider_service_recovery SET public_key=${(await P256Keypair.create()).did()}`).rejects.toThrow("cannot be changed");
    await expect(db.sql`DELETE FROM provider_service_recovery`).rejects.toThrow("cannot be changed");
  });

  it("refuses names that are not canonical reserved provider names", async () => {
    await expect(service.create("alice")).rejects.toThrow("Only reserved provider names");
    await expect(service.create("Admin")).rejects.toThrow("canonical lowercase");
    await expect(service.create("admin@other.example")).rejects.toThrow(ServiceAccountError);
    // Reserved names cannot be taken by ordinary account writers.
    await expect(db.sql`INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
      VALUES (${randomUUID()}, ${randomUUID()}, ${`abuse@${domain}`}, 'reserved')`).rejects.toThrow("reserved for the provider operator");
  });

  it("registers, binds and activates admin@ with provider-held keys under the offline recovery key", async () => {
    const created = await service.create("admin");
    expect(created).toMatchObject({ address: `admin@${domain}`, state: "active", active: true, operator: false, passkeys: 0 });
    const did = created.did!, [genesis] = logs.get(did)!;
    const rotation = (await db.sql<{ public_key: string }[]>`SELECT public_key FROM account_keys
      WHERE account_id=${created.accountId} AND role='plc-rotation'`)[0]!.public_key;
    expect(genesis!.rotationKeys).toEqual([recovery.did(), rotation]);
    expect(genesis!.services).toEqual({ hail: { type: "HailMessaging", endpoint: base } });
    const { sig, ...unsigned } = genesis as Operation & { sig: string };
    expect(await verifySignature(rotation, new Uint8Array(dagCbor.encode(unsigned)), Buffer.from(sig, "base64url"))).toBe(true);
    expect((await db.sql<{ role: string }[]>`SELECT role FROM account_keys WHERE account_id=${created.accountId} ORDER BY role`)
      .map(row => row.role)).toEqual(["hail-identity", "hail-messaging", "plc-rotation"]);
    expect((await db.sql`SELECT profile_version, provider_recovery_public_key FROM provider_service_account_evidence
      WHERE account_id=${created.accountId}`)[0]).toEqual({ profile_version: "hail-provider-service-v1", provider_recovery_public_key: recovery.did() });
    // The first PLC response was lost; reconciliation sent the exact operation once.
    expect(sends).toBe(1);
    // A retry resumes the same account without new keys or submissions.
    expect((await service.create("admin")).did).toBe(did);
    expect(sends).toBe(1);
    expect(await service.available()).not.toContain("admin");
    const session = { account_id: created.accountId, did, canonical_address: `admin@${domain}`, address_released_at: null,
      migration_state: null, scopes: ["account:read"], credential_id: randomUUID(), credential_expires_at: new Date() };
    expect(await new AccountApiRepository(db.sql).describe(session as never, origin))
      .toMatchObject({ custodyProfile: "provider-service", ownerRecoveryPublicKey: null, monitorVerificationMode: null });
  });

  it("issues host-only passkey links for admin@ and grants operator access on enrollment", async () => {
    await expect(service.passkeyLink("abuse")).rejects.toThrow("only for the admin");
    const link = await service.passkeyLink("admin");
    expect(link.url).toMatch(/^https:\/\/svr\.example\.org\/auth\/recover#token=racr_[A-Za-z0-9_-]{43}$/);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    const passkeys = new PasskeyAuth(db.sql, "svr.example.org", origin, verifyRegistration);
    const token = decodeURIComponent(link.url.split("#token=")[1]!), start = await passkeys.recoveryOptions(token);
    const credential = encodeBase64Url(new Uint8Array(randomBytes(32)));
    await passkeys.recover(token, start.challengeId, { id: credential, rawId: credential, type: "public-key",
      response: { clientDataJSON: "AA", attestationObject: "AA", transports: [] }, clientExtensionResults: {} }, "Operator laptop");
    expect((await service.list()).find(row => row.address === `admin@${domain}`)).toMatchObject({ operator: true, passkeys: 1 });
    await expect(passkeys.recoveryOptions(token)).rejects.toMatchObject({ status: 401 });
  });

  it("creates other reserved names on demand without operator access", async () => {
    const abuse = await service.create("abuse");
    expect(abuse).toMatchObject({ address: `abuse@${domain}`, active: true, operator: false });
    expect((await service.list()).map(row => row.address)).toEqual([`abuse@${domain}`, `admin@${domain}`]);
  });

  it("never replaces an existing non-service account at a reserved name", async () => {
    const id = randomUUID(), address = `ops@${domain}`;
    await db.sql`INSERT INTO provider_role_claims (canonical_address, account_id, owner_recovery_public_key)
      VALUES (${address}, ${id}, ${(await P256Keypair.create()).did()})`;
    await db.sql`INSERT INTO provider_accounts (id, tenant_id, canonical_address, onboarding_state)
      VALUES (${id}, ${randomUUID()}, ${address}, 'reserved')`;
    await expect(service.create("ops")).rejects.toThrow("Another account holds this address");
    expect(await service.available()).not.toContain("ops");
  });

  it("refuses transfer, fencing and custody transitions for service accounts", async () => {
    const did = (await service.list())[0]!.did!;
    await expect(db.sql`INSERT INTO provider_transfer_authorizations (did) VALUES (${did})`).rejects.toThrow("cannot transfer");
    await expect(db.sql`INSERT INTO provider_migration_fences (did) VALUES (${did})`).rejects.toThrow("cannot transfer");
    await expect(db.sql`INSERT INTO custody_transition_preparations (did) VALUES (${did})`).rejects.toThrow("cannot transfer");
  });
});
