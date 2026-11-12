import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { createWebCryptoSigner, decodePayload, encodeBase64Url, encodePayload, inspectSignedPayload, signPayload } from "@racrproto/codec";
import { ProviderDatabase } from "../src/db/database.js";
import { EmailAliases } from "../src/bridge/aliases.js";
import { EmailBridgeIntake } from "../src/bridge/intake.js";
import { EmailBridgeConverter, type DkimCheck } from "../src/bridge/converter.js";
import { EmailBridgeDelivery } from "../src/bridge/delivery.js";
import { createDkimCheck } from "../src/bridge/dkim.js";
import { createImageResolver } from "../src/bridge/image-fetcher.js";
import { EmailAliasOperations } from "../src/bridge/operations.js";
import { JmapOperations } from "../src/jmap/operations.js";
import { Hono } from "hono";
import { vi } from "vitest";
import { registerEmailBridgeIntakeRoutes } from "../src/bridge/routes.js";
import { handleEmail, handleRetry, type Env as WorkerEnv, type RetryBody } from "../deploy/cloudflare-email-worker/worker.js";
import type { AccountApiSession } from "../src/accounts/repository.js";
import { AccountMessaging } from "../src/accounts/messaging.js";
import { BodyRepository } from "../src/bodies/repository.js";
import { EnvelopeRepository } from "../src/envelopes/repository.js";
import { EnvelopeService } from "../src/envelopes/service.js";
import { GrantRepository } from "../src/grants/repository.js";
import { GrantService } from "../src/grants/service.js";
import { KeyEncryptor } from "../src/identity/key-encryption.js";
import { generateAccountKeys } from "../src/identity/keys.js";
import { OnboardingRepository } from "../src/onboarding/repository.js";
import { SenderProfileService } from "../src/profiles/service.js";
import { withFreshServingGenerations } from "../src/db/serving.js";
import type { HailDidResolver } from "../src/plc/resolver.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const DOMAIN = "in.bridge.example", ORIGIN = "https://provider.example.com", BASE = ORIGIN + "/hail";
const received = new Date("2026-11-11T12:00:00Z");

function png(width: number, height: number): Uint8Array {
  const chunk = (name: string, data: Uint8Array) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array((width * 4 + 1) * height))), chunk("IEND", new Uint8Array())]));
}
const email = (id: string, html = '<p>Hello from the newsletter.</p><img src="https://cdn.example/logo.png" alt="Logo">') =>
  `From: Field Notes <editors@fieldnotes.example>\r\nTo: x@${DOMAIN}\r\nSubject: Issue ${id}\r\nMessage-ID: <${id}@fieldnotes.example>\r\n` +
  `Date: Tue, 10 Nov 2026 09:30:00 -0500\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
const bytes = (text: string) => new TextEncoder().encode(text);
const none: DkimCheck = async () => ({ authentication: "none", signatures: [] });

integration("email bridge conversion and delivery", () => {
  let admin: SQL, db: ProviderDatabase, schema: string;
  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!); schema = `bridge_pipeline_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new ProviderDatabase(url.toString()); await db.migrate();
  });
  afterAll(async () => {
    if (db) await db.close();
    if (admin) { if (schema) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
  });

  const encryptor = new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const users: { id: string; did: string; address: string; keys: Awaited<ReturnType<typeof generateAccountKeys>> }[] = [];
  async function account(name: string) {
    const id = randomUUID(), did = `did:plc:${Array.from(randomBytes(24), byte => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`;
    const keys = await generateAccountKeys(id, encryptor), address = `${name}-${id.slice(0, 8)}@provider.example.com`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    for (const key of keys.keys) await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
      VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
    const user = { id, did, address, keys }; users.push(user); return user;
  }
  const resolver: HailDidResolver = { async resolve(did) {
    const user = users.find(entry => entry.did === did); if (!user) throw new Error("Unknown fixture identity");
    return { did, identityDidKey: user.keys.identityDidKey, messagingDidKey: user.keys.messagingDidKey, serviceBase: BASE, evidence: { document: {}, data: {}, log: [] } };
  } };

  /** A bridge account with a Sender Profile, and a way for users to grant it. */
  async function bridge(category = "email") {
    const sender = await account("email"), onboarding = new OnboardingRepository(db.sql), grants = new GrantRepository(db.sql);
    const profile = await new SenderProfileService(onboarding, encryptor, resolver, BASE).createOrReuse(sender.address,
      { display_name: "Email bridge", categories: [{ id: category, label: "Email" }, { id: "other", label: "Other" }] });
    const now = Math.floor(Date.now() / 1000), evidence = { document: {}, data: {}, log: [] };
    const binding = { type: "hail.address-binding" as const, version: 2 as const, address: sender.address, did: sender.did, issued_at: now, key_id: sender.did + "#hail-identity" };
    const raw = await signPayload("hail.address-binding", binding, createWebCryptoSigner(binding.key_id, sender.keys.identityPrivateKey));
    const hash = (value: Uint8Array) => new Uint8Array(createHash("sha256").update(value).digest());
    const service = new GrantService(onboarding, grants, encryptor, resolver, { async verify() { return { address: sender.address, did: sender.did, binding,
      representation: raw, digest: hash(raw), serviceBase: BASE, identityDidKey: sender.keys.identityDidKey, messagingDidKey: sender.keys.messagingDidKey,
      plcEvidence: evidence, verifiedAt: new Date() }; } },
    { async verify() { return { did: sender.did, profile: profile.payload, representation: profile.cose, digest: profile.digest, etag: encodeBase64Url(profile.digest),
      serviceBase: BASE, messagingDidKey: sender.keys.messagingDidKey, plcEvidence: evidence, verifiedAt: new Date() }; } }, BASE);
    const subscribe = async (address: string, values = [category]) => {
      const grant = await service.createOrReuse(address, sender.address, { scope: { type: "categories", values }, expiresAt: null });
      await grants.acceptReceivedRevision({ ...grant, localAccountId: sender.id });
      return grant;
    };
    return { sender, subscribe, grants, service };
  }

  async function queue(owner: string, id: string, html?: string) {
    const alias = await new EmailAliases(db.sql, DOMAIN).create(owner, { label: "Field Notes" });
    expect(await new EmailBridgeIntake(db.sql, DOMAIN).submit({ recipient: alias.address, raw: bytes(email(id, html)), receivedAt: received })).toBe("accepted");
    const [row] = await db.sql<{ id: string }[]>`SELECT intake.id FROM email_bridge_intake intake WHERE alias_id = ${alias.id}`;
    return { alias, intakeId: row!.id };
  }
  const row = async (id: string) => (await db.sql<{ state: string; failure: string | null; raw: Uint8Array | null; converted_body: Uint8Array | null;
    message_id: string | null; diagnostics: Record<string, unknown> | null }[]>`
    SELECT state, failure, raw, converted_body, message_id, diagnostics FROM email_bridge_intake WHERE id = ${id}`)[0]!;
  /** Work queued rows until none is ready, as the long-running workers do. */
  const drain = async (worker: { workOne(): Promise<boolean> }) => { for (let i = 0; i < 50 && await worker.workOne(); i++); };

  describe("converter", () => {
    it("converts a queued message, bundles its image, discards the original and records diagnostics", async () => {
      const owner = await account("reader"), { intakeId } = await queue(owner.id, `conv-${randomUUID()}`);
      const logo = png(200, 60), requested: string[] = [];
      await drain(new EmailBridgeConverter(db.sql, { checkDkim: none, resolveRemote: async url => { requested.push(url); return url.endsWith("logo.png") ? logo : null; } }));
      const result = await row(intakeId);
      expect(result).toMatchObject({ state: "converted", raw: null, failure: null });
      expect(requested).toEqual(["https://cdn.example/logo.png"]);
      const body = decodePayload("hail.body.spt-3", new Uint8Array(result.converted_body!));
      expect(body.origin).toEqual({ type: "email", from_address: "editors@fieldnotes.example", from_name: "Field Notes", authentication: "none",
        received_at: Math.floor(received.getTime() / 1000) });
      expect(body.assets.assets[0]).toMatchObject({ media_type: "image/png", width: 200, height: 60 });
      expect(result.diagnostics).toEqual({ dkim: { authentication: "none", signatures: [] } });
    });

    it("abandons an unusable message and treats a failing image fetcher as unavailable images", async () => {
      const owner = await account("reader"), alias = await new EmailAliases(db.sql, DOMAIN).create(owner.id, { label: "Broken" });
      await new EmailBridgeIntake(db.sql, DOMAIN).submit({ recipient: alias.address, raw: bytes("Subject: No sender\r\nMessage-ID: <x@y>\r\n\r\nBody\r\n"), receivedAt: received });
      const [unusable] = await db.sql<{ id: string }[]>`SELECT id FROM email_bridge_intake WHERE alias_id = ${alias.id}`;
      await drain(new EmailBridgeConverter(db.sql, { checkDkim: none, resolveRemote: async () => null }));
      expect(await row(unusable!.id)).toMatchObject({ state: "dead", raw: null, failure: "unconvertible: missing-sender" });

      const { intakeId } = await queue(owner.id, `retry-${randomUUID()}`);
      await drain(new EmailBridgeConverter(db.sql, { checkDkim: async () => { throw new Error("DNS down"); },
        resolveRemote: async () => { throw new Error("unexpected"); } }));
      const result = await row(intakeId);
      // Neither failure is the message's fault: the image becomes a link and the author is reported unauthenticated.
      expect(result.state).toBe("converted");
      expect(result.diagnostics).toEqual({ "image-unavailable": 1,
        dkim: { authentication: "none", signatures: [], reason: "check failed: Error: DNS down" } });
      expect(decodePayload("hail.body.spt-2", new Uint8Array(result.converted_body!)).origin?.authentication).toBe("none");
    });

    it("reclaims a message whose worker died, and leaves a reclaimed message to its new owner", async () => {
      const owner = await account("reader"), { intakeId } = await queue(owner.id, `lease-${randomUUID()}`);
      await db.sql`UPDATE email_bridge_intake SET state = 'converting', attempts = 1, next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = ${intakeId}`;
      await drain(new EmailBridgeConverter(db.sql, { checkDkim: none, resolveRemote: async () => null }));
      expect((await row(intakeId)).state).toBe("converted");
    });

    it("does not resurrect a message whose alias was deleted during conversion", async () => {
      const owner = await account("reader"), { alias, intakeId } = await queue(owner.id, `deleted-${randomUUID()}`);
      const converter = new EmailBridgeConverter(db.sql, { checkDkim: none, resolveRemote: async () => {
        await new EmailAliases(db.sql, DOMAIN).remove(owner.id, alias.id); return null; } });
      await converter.workOne();
      expect(await row(intakeId)).toMatchObject({ state: "dead", failure: "alias deleted", converted_body: null });
    });

    it("reports dkim-aligned only for a valid signature from the author's own domain", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const record = `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
      const dns = async (name: string) => { if (name === "s1._domainkey.fieldnotes.example" || name === "s1._domainkey.mailer.example") return [[record]];
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); };
      const sign = async (domain: string, message: string) => {
        const signed = await dkimSign(message, { signatureData: [{ signingDomain: domain, selector: "s1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
        return bytes(signed.signatures + message);
      };
      const check = createDkimCheck(dns);
      const message = email("dkim-1");
      expect(await check(await sign("fieldnotes.example", message), "editors@fieldnotes.example")).toEqual({ authentication: "dkim-aligned",
        signatures: [{ domain: "fieldnotes.example", result: "pass", aligned: true }] });
      expect(await check(await sign("mailer.example", message), "editors@fieldnotes.example")).toMatchObject({ authentication: "none",
        reason: "no passing signature from the sender's domain", signatures: [{ domain: "mailer.example", result: "pass", aligned: false }] });
      const tampered = await sign("fieldnotes.example", message);
      const altered = await check(bytes(Buffer.from(tampered).toString().replace("Hello", "Hullo")), "editors@fieldnotes.example");
      expect(altered).toMatchObject({ authentication: "none", signatures: [{ domain: "fieldnotes.example", result: "neutral", comment: "body hash did not verify" }] });
      expect(await check(bytes(message), "editors@fieldnotes.example")).toEqual({ authentication: "none", signatures: [], reason: "no DKIM signature" });
      expect(await check(await sign("fieldnotes.example", message), "someone@fieldnotes.example")).toMatchObject({ authentication: "none",
        reason: "From header differs from the converted sender" });
    });

    it("runs under the converter role, which cannot read anything but the intake queue", async () => {
      await db.sql.unsafe(readFileSync(new URL("../deploy/email-bridge/converter-role.sql", import.meta.url), "utf8"));
      const login = `email_converter_${randomUUID().replaceAll("-", "").slice(0, 12)}`, password = randomBytes(18).toString("base64url");
      await admin.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE hail_email_converter`);
      const url = new URL(process.env.DATABASE_URL!);
      url.username = login; url.password = password; url.searchParams.set("options", `-csearch_path=${schema}`);
      const limited = new SQL(url.toString(), { max: 1 });
      try {
        const owner = await account("reader"), { intakeId } = await queue(owner.id, `role-${randomUUID()}`);
        await drain(new EmailBridgeConverter(limited, { checkDkim: none, resolveRemote: async () => null }));
        expect((await row(intakeId)).state).toBe("converted");
        for (const query of [
          limited`SELECT * FROM provider_accounts LIMIT 1`, limited`SELECT encrypted_private_key FROM account_keys LIMIT 1`,
          limited`SELECT * FROM email_bridge_aliases LIMIT 1`, limited`SELECT alias_id FROM email_bridge_intake LIMIT 1`,
          limited`SELECT * FROM delivered_messages LIMIT 1`, limited`UPDATE email_bridge_intake SET alias_id = alias_id`,
          limited`INSERT INTO email_bridge_intake (id) VALUES (gen_random_uuid())`, limited`DELETE FROM email_bridge_intake`,
        ]) await expect(query).rejects.toThrow(/permission denied/);
      } finally {
        await limited.close();
        await admin.unsafe(`DROP ROLE ${login}`);
      }
    });
  });

  describe("delivery", () => {
    function messaging(submitted: string[], failures = { count: 0 }) {
      const envelopes = new EnvelopeRepository(db.sql), grants = new GrantRepository(db.sql);
      return new AccountMessaging(db.sql, new BodyRepository(db.sql), envelopes,
        new EnvelopeService(new OnboardingRepository(db.sql), grants, envelopes, encryptor, resolver, BASE), async (did, id) => {
          if (failures.count > 0) { failures.count--; throw new Error("Lost submission response"); }
          submitted.push(id); return { messageId: id, outcome: "received", accepted: false };
        });
    }
    const converter = () => new EmailBridgeConverter(db.sql, { checkDkim: none, resolveRemote: async () => null });

    it("delivers converted mail to a recipient who granted the bridge, as a signed hail stating its origin", async () => {
      const { sender, subscribe } = await bridge(), owner = await account("reader");
      const grant = await subscribe(owner.address);
      const { intakeId } = await queue(owner.id, `deliver-${randomUUID()}`);
      await drain(converter());
      const submitted: string[] = [];
      await withFreshServingGenerations(db.sql, () => drain(new EmailBridgeDelivery(db.sql, messaging(submitted), { address: sender.address, category: "email" })));
      const result = await row(intakeId);
      expect(result).toMatchObject({ state: "delivered", converted_body: null, raw: null });
      expect(submitted).toEqual([result.message_id]);
      const envelope = inspectSignedPayload("hail.envelope", (await new EnvelopeRepository(db.sql).sent(sender.did, result.message_id!))!).payload;
      expect(envelope).toMatchObject({ from: sender.did, to: owner.did, category: "email", authorization: { type: "grant", grant_id: grant.payload.grant_id },
        reply: { allowed: false } });
    });

    it("abandons mail for a recipient without a Grant, with only another category, or whose alias is paused", async () => {
      const { sender, subscribe } = await bridge(), stranger = await account("reader"), other = await account("reader"), pauser = await account("reader");
      await subscribe(other.address, ["other"]); await subscribe(pauser.address);
      const a = await queue(stranger.id, `none-${randomUUID()}`), b = await queue(other.id, `other-${randomUUID()}`), c = await queue(pauser.id, `paused-${randomUUID()}`);
      await drain(converter());
      await new EmailAliases(db.sql, DOMAIN).update(pauser.id, c.alias.id, { state: "paused" });
      const submitted: string[] = [];
      await withFreshServingGenerations(db.sql, () => drain(new EmailBridgeDelivery(db.sql, messaging(submitted), { address: sender.address, category: "email" })));
      expect(submitted).toEqual([]);
      expect(await row(a.intakeId)).toMatchObject({ state: "dead", failure: "no active grant to the bridge", converted_body: null });
      expect(await row(b.intakeId)).toMatchObject({ state: "dead", failure: "no active grant to the bridge" });
      expect(await row(c.intakeId)).toMatchObject({ state: "dead", failure: "recipient unavailable" });
    });

    it("revalidates the converter's output and refuses a body without an email origin", async () => {
      const { sender, subscribe } = await bridge(), owner = await account("reader");
      await subscribe(owner.address);
      const forged = await queue(owner.id, `forged-${randomUUID()}`), garbage = await queue(owner.id, `garbage-${randomUUID()}`);
      const plain = encodePayload("hail.body.spt-2", { version: 1, profile: "spt-2",
        blocks: [{ _type: "block", style: "normal", children: [{ _type: "span", text: "No origin", marks: [] }], markDefs: [] }] });
      await db.sql`UPDATE email_bridge_intake SET state = 'converted', raw = NULL, converted_body = ${plain} WHERE id = ${forged.intakeId}`;
      await db.sql`UPDATE email_bridge_intake SET state = 'converted', raw = NULL, converted_body = ${randomBytes(64)} WHERE id = ${garbage.intakeId}`;
      const submitted: string[] = [];
      await withFreshServingGenerations(db.sql, () => drain(new EmailBridgeDelivery(db.sql, messaging(submitted), { address: sender.address, category: "email" })));
      expect(submitted).toEqual([]);
      for (const id of [forged.intakeId, garbage.intakeId]) expect(await row(id)).toMatchObject({ state: "dead", failure: "converted body is invalid" });
    });

    it("retries a lost submission with the same envelope", async () => {
      const { sender, subscribe } = await bridge(), owner = await account("reader");
      await subscribe(owner.address);
      const { intakeId } = await queue(owner.id, `retry-${randomUUID()}`);
      await drain(converter());
      const submitted: string[] = [], failures = { count: 1 };
      const delivery = new EmailBridgeDelivery(db.sql, messaging(submitted, failures), { address: sender.address, category: "email" });
      await withFreshServingGenerations(db.sql, () => delivery.workOne());
      const first = await row(intakeId);
      expect(first.state).toBe("converted");
      await db.sql`UPDATE email_bridge_intake SET next_attempt_at = clock_timestamp() WHERE id = ${intakeId}`;
      await withFreshServingGenerations(db.sql, () => delivery.workOne());
      const second = await row(intakeId);
      expect(second).toMatchObject({ state: "delivered", message_id: first.message_id });
      expect(submitted).toEqual([first.message_id]);
      expect(await db.sql`SELECT 1 FROM sent_envelopes WHERE sender_did = ${sender.did} AND message_id = ${first.message_id}`).toHaveLength(1);
    });

    it("keeps mail when the bridge account is missing, rather than losing it", async () => {
      const owner = await account("reader"), { intakeId } = await queue(owner.id, `nosender-${randomUUID()}`);
      await drain(converter());
      const delivery = new EmailBridgeDelivery(db.sql, messaging([]), { address: "missing@provider.example.com", category: "email" });
      await expect(withFreshServingGenerations(db.sql, () => delivery.workOne())).rejects.toThrow("not an active local account");
      expect((await row(intakeId)).state).toBe("converted");
    });
  });

  describe("inbound email setting and aliases", () => {
    it("is off until the user grants the bridge, and gates alias creation and intake on that Grant", async () => {
      const { sender, subscribe, grants, service } = await bridge(), owner = await account("reader");
      const operations = new EmailAliasOperations(db.sql, grants, DOMAIN, { address: sender.address, category: "email" });
      const me = { account_id: owner.id, did: owner.did };
      expect(await operations.get(me, true)).toEqual({ available: true, domain: DOMAIN, sender: { address: sender.address, category: "email" },
        enabled: false, grant: null });
      await expect(operations.create(me, "Field Notes")).rejects.toMatchObject({ status: 409 });

      const grant = await subscribe(owner.address);
      const on = await operations.get(me, false);
      expect(on).toMatchObject({ enabled: true, grant: { grantId: grant.payload.grant_id, revision: grant.payload.revision,
        digest: encodeBase64Url(grant.digest) }, aliases: [] });
      const { alias } = await operations.create(me, "Field Notes");
      expect(alias).toMatchObject({ label: "Field Notes", messageCount: 0, lastReceivedAt: null });
      expect((await operations.get(me, false) as { aliases: unknown[] }).aliases).toEqual([alias]);

      const intake = new EmailBridgeIntake(db.sql, DOMAIN, undefined, { address: sender.address, category: "email" });
      expect(await intake.check(alias.address)).toBe("accept");
      // Turning inbound email off refuses mail at the edge, before anything is stored.
      await service.revoke(owner.address, grant.payload.grant_id);
      expect(await intake.check(alias.address)).toBe("reject");
      expect(await intake.submit({ recipient: alias.address, raw: bytes(email("off")), receivedAt: received })).toBe("reject");
      expect((await operations.get(me, true)).enabled).toBe(false);
      // A misconfigured bridge account defers rather than refusing every sender permanently.
      const broken = new EmailBridgeIntake(db.sql, DOMAIN, undefined, { address: "missing@provider.example.com", category: "email" });
      expect(await broken.check(alias.address)).toBe("defer");

      expect(await operations.destroy(owner.id, [alias.id, randomUUID()])).toMatchObject({ destroyed: [alias.id] });
      await expect(operations.destroy(owner.id, [])).rejects.toMatchObject({ status: 400 });
      await expect(operations.destroy(owner.id, ["not-a-uuid"])).rejects.toMatchObject({ status: 400 });
    });

    it("shows inbound email on as soon as the user's Grant exists, before the bridge has received it", async () => {
      const { sender, service } = await bridge(), owner = await account("reader");
      const operations = new EmailAliasOperations(db.sql, new GrantRepository(db.sql), DOMAIN, { address: sender.address, category: "email" });
      // Created by the user, not yet accepted by the bridge account.
      const grant = await service.createOrReuse(owner.address, sender.address, { scope: { type: "categories", values: ["email"] }, expiresAt: null });
      expect(await operations.get({ account_id: owner.id, did: owner.did }, true)).toMatchObject({ enabled: true, grant: { grantId: grant.payload.grant_id } });
      const { alias } = await operations.create({ account_id: owner.id, did: owner.did }, "Early");
      // Mail still waits for the bridge's own record of the Grant.
      expect(await new EmailBridgeIntake(db.sql, DOMAIN, undefined, { address: sender.address, category: "email" }).check(alias.address)).toBe("reject");
      await service.revoke(owner.address, grant.payload.grant_id);
      expect((await operations.get({ account_id: owner.id, did: owner.did }, true)).enabled).toBe(false);
    });

    it("exposes the operations only to browser sessions with the right scopes, and reports when the provider has no bridge", async () => {
      const { sender, subscribe, grants, service } = await bridge(), owner = await account("reader");
      await subscribe(owner.address);
      const emailAliases = new EmailAliasOperations(db.sql, grants, DOMAIN, { address: sender.address, category: "email" });
      const base = { accounts: {} as never, grants, service };
      const session = (scopes: string[], passkey = true) => ({ account_id: owner.id, did: owner.did, canonical_address: owner.address,
        scopes, passkey_credential_id: passkey ? "fixture" : null, serving_generation: 1, migration_state: null }) as unknown as AccountApiSession;
      const operations = new JmapOperations({ ...base, emailAliases });
      const created = await operations.dispatch(session(["messages:read", "messages:write"]), "HailEmailAlias/create", { accountId: "a", label: "News" });
      expect(created).toMatchObject({ accountId: "a", alias: { label: "News" } });
      await expect(operations.dispatch(session(["messages:read", "messages:write"], false), "HailEmailAlias/create", { label: "Api" }))
        .rejects.toMatchObject({ type: "forbidden" });
      await expect(operations.dispatch(session(["messages:read"]), "HailEmailAlias/create", { label: "Read only" }))
        .rejects.toMatchObject({ type: "forbidden" });
      await expect(operations.dispatch(session(["messages:read", "messages:write"]), "HailEmailAlias/create", { label: "x", extra: 1 }))
        .rejects.toMatchObject({ type: "invalidArguments" });
      expect(await operations.dispatch(session(["messages:read"], false), "HailEmailAlias/get", { summary: true })).toMatchObject({ enabled: true });
      expect(await new JmapOperations(base).dispatch(session(["messages:read"]), "HailEmailAlias/get", {})).toEqual({ available: false });
      const ids = [(created as { alias: { id: string } }).alias.id];
      await expect(operations.dispatch(session(["messages:write"]), "HailEmailAlias/destroy", { ids, unsubscribe: "yes" }))
        .rejects.toMatchObject({ type: "invalidArguments" });
      await expect(operations.dispatch(session(["messages:write"], false), "HailEmailAlias/destroy", { ids, unsubscribe: true }))
        .rejects.toMatchObject({ type: "forbidden" });
      expect(await operations.dispatch(session(["messages:write"]), "HailEmailAlias/destroy", { ids, unsubscribe: true }))
        .toMatchObject({ destroyed: ids, unsubscribeRequests: 0 });
    });
  });

  describe("Cloudflare adapter against the intake contract", () => {
    it("accepts, refuses and retries exactly as the provider decides", async () => {
      const { sender, subscribe } = await bridge(), owner = await account("reader"), stranger = await account("reader");
      const senderConfig = { address: sender.address, category: "email" }, token = encodeBase64Url(randomBytes(32));
      const app = new Hono();
      registerEmailBridgeIntakeRoutes(app, new EmailBridgeIntake(db.sql, DOMAIN, undefined, senderConfig), token, 10 * 1024 * 1024);
      let providerDown = false;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (providerDown) throw new TypeError("fetch failed");
        return app.request(url, { ...init, body: init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null });
      });
      const held = new Map<string, Uint8Array>(), queue: RetryBody[] = [];
      const env: WorkerEnv = { PROVIDER_ORIGIN: ORIGIN, ALIAS_DOMAIN: DOMAIN, INTAKE_TOKEN: token,
        PENDING: { put: async (key, value) => { held.set(key, value); }, get: async key => { const v = held.get(key); return v ? { arrayBuffer: async () => v.slice().buffer } : null; },
          delete: async key => { held.delete(key); } },
        RETRY: { send: async body => { queue.push(body); } } };
      const deliver = async (to: string, id: string) => {
        const rejected: string[] = [], bytesOut = bytes(email(id));
        await handleEmail({ from: "bounce@fieldnotes.example", to, rawSize: bytesOut.length, setReject: reason => { rejected.push(reason); },
          raw: new ReadableStream({ start(controller) { controller.enqueue(bytesOut); controller.close(); } }) }, env);
        return rejected;
      };
      const stored = async (aliasId: string) => (await db.sql`SELECT id FROM email_bridge_intake WHERE alias_id = ${aliasId}`).length;
      try {
        await subscribe(owner.address);
        const mine = await new EmailAliases(db.sql, DOMAIN).create(owner.id, { label: "Mine" });
        const theirs = await new EmailAliases(db.sql, DOMAIN).create(stranger.id, { label: "No consent" });

        expect(await deliver(mine.address, "c1")).toEqual([]);
        expect(await deliver(mine.address, "c1")).toEqual([]);
        expect(await stored(mine.id)).toBe(1);
        expect(await deliver(theirs.address, "c2")).toEqual(["No such recipient"]);
        expect(await deliver(`aaaaaaaaaaaa@${DOMAIN}`, "c3")).toEqual(["No such recipient"]);
        expect(await stored(theirs.id)).toBe(0);

        // During an outage the adapter keeps the message; the retry hands it over and the provider still decides.
        providerDown = true;
        expect(await deliver(mine.address, "c4")).toEqual([]);
        expect(await deliver(theirs.address, "c5")).toEqual([]);
        expect(queue).toHaveLength(2);
        providerDown = false;
        const acks: string[] = [];
        await handleRetry(queue.map(body => ({ body, attempts: 1, ack: () => { acks.push(body.recipient); }, retry: () => { throw new Error("unexpected retry"); } })), env);
        expect(acks).toEqual([mine.address, theirs.address]);
        expect(held.size).toBe(0);
        expect(await stored(mine.id)).toBe(2);
        expect(await stored(theirs.id)).toBe(0);
      } finally { vi.unstubAllGlobals(); }
    });
  });

  describe("image fetcher", () => {
    const respond = (status: number, body: Uint8Array | null, headers: Record<string, string> = {}) =>
      new Response(body as BodyInit | null, { status, headers });

    it("follows bounded HTTPS redirects, sends the image headers and stops at the byte limit", async () => {
      const seen: Request[] = [], image = png(10, 10);
      const resolve = createImageResolver(async request => {
        seen.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/a") return respond(302, null, { Location: "/b" });
        if (url.pathname === "/b") return respond(301, null, { Location: "https://cdn2.example/c#fragment" });
        if (url.pathname === "/c") return respond(200, image);
        if (url.pathname === "/http") return respond(302, null, { Location: "http://cdn.example/c" });
        if (url.pathname === "/loop") return respond(302, null, { Location: "/loop" });
        if (url.pathname === "/big") return respond(200, new Uint8Array(5000));
        if (url.pathname === "/lie") return respond(200, new Uint8Array(10), { "Content-Length": "99999" });
        return respond(404, null);
      });
      expect(await resolve("https://cdn.example/a", 4096)).toEqual(image);
      expect(seen.map(request => request.url)).toEqual(["https://cdn.example/a", "https://cdn.example/b", "https://cdn2.example/c"]);
      expect(seen[0]!.headers.get("accept")).toBe("image/png,image/jpeg;q=0.9,image/*;q=0.5");
      expect(seen[0]!.headers.get("user-agent")).toContain("HailEmailBridge");
      for (const path of ["/http", "/loop", "/big", "/lie", "/missing"]) expect(await resolve(`https://cdn.example${path}`, 4096)).toBeNull();
      expect(await resolve("https://cdn.example/c", 0)).toBeNull();
    });

    it("turns transport refusals into unavailable images", async () => {
      const resolve = createImageResolver(async () => { throw new Error("did not resolve exclusively to public addresses"); });
      expect(await resolve("https://internal.example/x.png", 4096)).toBeNull();
    });
  });
});
