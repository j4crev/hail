import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog, type ExportedOp } from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { PlcMonitor } from "../src/monitor.js";
import { MonitorDatabase } from "../src/database.js";
import { hash } from "../src/http.js";
import { EnrollmentProviders } from "../src/providers.js";
import { MonitorSigner } from "../src/signing.js";
import { createProviderDeregistrationApi, createProviderRegistrationApi, registrationDocument, REGISTRATION_PATH } from "../src/provider-registration.js";
import type { ProvisionedProvider } from "../src/receiver-provisioning.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("self-service monitor provider registration v2", () => {
  let db: MonitorDatabase, providers: EnrollmentProviders;
  const monitorOrigin = "https://monitor.example", receiverOrigin = "https://alerts.monitor.example";
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  const codes: { email: string; code: string; providerOrigin: string }[] = [], provisioned: ProvisionedProvider[] = [];
  let receiverDown = false;
  const receiver = {
    origin: receiverOrigin,
    async verifyOperator(email: string, code: string, providerOrigin: string) {
      if (receiverDown) throw Error("down");
      codes.push({ email, code, providerOrigin });
    },
    async provision(provider: ProvisionedProvider) { if (receiverDown) throw Error("down"); provisioned.push(provider); },
  };
  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith("/hail_test_")) throw Error("Use disposable database runner");
    db = new MonitorDatabase(process.env.DATABASE_URL!); await db.migrate(); providers = new EnrollmentProviders(db.sql);
  });
  afterAll(async () => { await db?.close(); });

  function setup(input: { providerOrigin: string; webOrigin?: string; operatorEmail?: string }) {
    const request = { operatorEmail: "Ops@Provider.Example", ...input, registrationSecret: randomBytes(32).toString("base64url"),
      expiresAt: Math.floor(Date.now() / 1000) + 600 };
    const published = new Map<string, unknown>(), calls: string[] = [];
    const api = createProviderRegistrationApi(providers, signer, monitorOrigin, receiver, async url => {
      calls.push(url); return published.has(url) ? Response.json(published.get(url)) : new Response(null, { status: 404 });
    });
    const post = async (extra: Record<string, unknown> = {}, body: Record<string, unknown> = request) => {
      const response = await api.fetch(new Request(monitorOrigin + "/api/v1/providers/register", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const publish = async () => {
      const document = await registrationDocument({ ...request, monitorApiOrigin: monitorOrigin });
      for (const origin of [input.providerOrigin, ...(input.webOrigin ? [input.webOrigin] : [])]) published.set(origin + REGISTRATION_PATH, document);
      return document;
    };
    return { request, published, calls, post, publish };
  }

  it("proves every origin, verifies the operator by email, then issues both credentials and provisions the receiver", async () => {
    const t = setup({ providerOrigin: "https://svr.provider.example", webOrigin: "https://provider.example" });
    expect((await t.post()).status).toBe(409); // nothing published yet
    t.published.set(t.request.providerOrigin + REGISTRATION_PATH, await registrationDocument({ ...t.request, monitorApiOrigin: monitorOrigin }));
    expect((await t.post()).status).toBe(409); // web origin has not opted in
    const document = await t.publish();
    expect(document).toMatchObject({ version: 2, webOrigin: "https://provider.example" });
    expect(JSON.stringify(document)).not.toContain(t.request.registrationSecret);

    const sent = await t.post();
    expect(sent).toMatchObject({ status: 202, body: { verification: "email-sent" } });
    expect(codes.at(-1)).toMatchObject({ email: "Ops@provider.example", providerOrigin: t.request.providerOrigin });
    const code = codes.at(-1)!.code;
    expect((await t.post()).status).toBe(202);
    expect(codes).toHaveLength(1); // an exact retry does not send another email
    expect((await t.post({ resend: true })).status).toBe(429); // cooldown
    expect(await db.sql`SELECT id FROM monitor_enrollment_providers WHERE provider_origin=${t.request.providerOrigin}`).toHaveLength(0);
    const stored = await db.sql`SELECT * FROM monitor_provider_registration_codes`;
    expect(JSON.stringify(stored)).not.toContain(code);

    const wrong = code === "00000000" ? "11111111" : "00000000";
    expect((await t.post({ operatorCode: wrong })).status).toBe(409);
    const issued = await t.post({ operatorCode: code });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ providerOrigin: t.request.providerOrigin, webOrigin: "https://provider.example",
      receiverOrigin, apiOrigin: monitorOrigin, monitorPublicKey: signer.publicDidKey });
    expect(issued.body.token).not.toBe(issued.body.receiverToken);
    expect(provisioned.at(-1)).toEqual({ providerId: issued.body.providerId, providerOrigin: t.request.providerOrigin,
      webOrigin: "https://provider.example", tokenHash: await hash(issued.body.receiverToken as string), enabled: true });
    expect(t.calls.every(url => url.endsWith(REGISTRATION_PATH))).toBe(true);

    // Lost response: an exact retry returns the same credentials without re-provisioning.
    const provisions = provisioned.length;
    expect((await t.post({ operatorCode: code })).body).toEqual(issued.body);
    expect((await t.post()).body).toEqual(issued.body);
    expect(provisioned).toHaveLength(provisions);
    const row = (await db.sql`SELECT * FROM monitor_enrollment_providers WHERE id=${issued.body.providerId}`)[0];
    expect(row).toMatchObject({ alert_origin: receiverOrigin, operator_email: "Ops@provider.example", web_origin: "https://provider.example" });
    for (const secret of [issued.body.token, issued.body.receiverToken, t.request.registrationSecret])
      expect(JSON.stringify(row)).not.toContain(secret);
    expect((await providers.authenticate(new Request(monitorOrigin, { headers: { Authorization: "Bearer " + issued.body.token } })))
      .provider_origin).toBe(t.request.providerOrigin);

    await providers.setEnabled(issued.body.providerId as string, false);
    expect((await t.post({ operatorCode: code })).status).toBe(409); // cannot resurrect a disabled registration
    expect(await providers.receiverRecord(issued.body.providerId as string)).toMatchObject({ enabled: false });
  });

  it("limits code attempts and lets the operator request a fresh code", async () => {
    const t = setup({ providerOrigin: "https://svr.limited.example" });
    await t.publish();
    expect((await t.post()).status).toBe(202);
    const code = codes.at(-1)!.code, wrong = code === "00000000" ? "11111111" : "00000000";
    for (let attempt = 0; attempt < 5; attempt++) expect((await t.post({ operatorCode: wrong })).status).toBe(409);
    expect((await t.post({ operatorCode: code })).status).toBe(409); // exhausted, even with the right code
    await db.sql`UPDATE monitor_provider_registration_codes SET sent_at=now()-interval '2 minutes'`;
    expect((await t.post({ resend: true })).status).toBe(202);
    const issued = await t.post({ operatorCode: codes.at(-1)!.code });
    expect(issued.status).toBe(200);
    expect(issued.body.webOrigin).toBeNull();
  });

  it("does not store a code when the receiver cannot send it, and retries provisioning on an exact retry", async () => {
    const t = setup({ providerOrigin: "https://svr.retry.example" });
    await t.publish();
    receiverDown = true;
    expect((await t.post()).status).toBe(503);
    expect(await db.sql`SELECT 1 FROM monitor_provider_registration_codes WHERE provider_origin=${t.request.providerOrigin}`).toHaveLength(0);
    receiverDown = false;
    expect((await t.post()).status).toBe(202);
    const code = codes.at(-1)!.code;
    receiverDown = true;
    expect((await t.post({ operatorCode: code })).status).toBe(503); // created, but provisioning failed
    receiverDown = false;
    const issued = await t.post({ operatorCode: code });
    expect(issued.status).toBe(200);
    expect(provisioned.at(-1)?.providerId).toBe(issued.body.providerId);
  });

  it("refuses a different request for an existing secret, invalid input, and unconfigured receivers", async () => {
    const t = setup({ providerOrigin: "https://svr.conflict.example" });
    await t.publish();
    expect((await t.post()).status).toBe(202);
    expect((await t.post({ operatorEmail: "other@provider.example" })).status).toBe(409);
    expect((await t.post({ operatorEmail: "not-an-email" })).status).toBe(400);
    expect((await t.post({ operatorCode: "123" })).status).toBe(400);
    expect((await t.post({ expiresAt: 1 })).status).toBe(400);
    expect((await t.post({ alertOrigin: "https://alerts.example" })).status).toBe(400); // v1 field
    const unconfigured = createProviderRegistrationApi(providers, signer, monitorOrigin, undefined, async () => { throw Error(); });
    expect((await unconfigured.fetch(new Request(monitorOrigin, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t.request) }))).status).toBe(503);
  });

  it("refuses invalid origins before any outbound requests", async () => {
    let calls = 0;
    const api = createProviderRegistrationApi(providers, signer, monitorOrigin, receiver, async () => { calls++; throw Error(); });
    for (const origins of [{ providerOrigin: "http://provider.example" }, { providerOrigin: "https://127.0.0.1" },
      { providerOrigin: "https://provider.example:8443" }, { providerOrigin: "https://provider.example/path" },
      { providerOrigin: "https://svr.provider.example", webOrigin: "https://svr.provider.example" }]) {
      const response = await api.fetch(new Request(monitorOrigin + "/api/v1/providers/register", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...origins,
          operatorEmail: "ops@provider.example", registrationSecret: randomBytes(32).toString("base64url"),
          expiresAt: Math.floor(Date.now() / 1000) + 600 }) }));
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  async function register(t: ReturnType<typeof setup>) {
    await t.publish();
    expect((await t.post()).status).toBe(202);
    const issued = await t.post({ operatorCode: codes.at(-1)!.code });
    expect(issued.status).toBe(200);
    return issued.body as Record<string, string>;
  }
  /** Enrolls one managed identity under a registration, as signup does. */
  async function enroll(providerId: string, providerOrigin: string) {
    const owner = await P256Keypair.create();
    const genesis = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [owner.did()], verificationMethods: {},
      services: { hail: { type: "HailMessaging", endpoint: providerOrigin + "/hail" } }, alsoKnownAs: [] }, owner);
    const did = await didForCreateOp(genesis), cid = (await cidForCbor(genesis)).toString();
    const state = (await validateOperationLog(did, [genesis]))!;
    const audit: ExportedOp[] = [{ did, cid, operation: genesis, nullified: false, createdAt: new Date(Date.now() - 1000).toISOString() }];
    const monitor = new PlcMonitor(db.sql, { async getAuditableLog() { return audit; }, async getOperationLog() { return [genesis]; },
      async getDocumentData() { return state; }, async exportAfter() { return []; } });
    await monitor.enroll(did, cid, receiverOrigin + "/hail/signup", state, providerId);
    return did;
  }
  const stopped = async (did: string) => (await db.sql`SELECT stopped_at FROM monitored_dids WHERE did=${did}`)[0]!.stopped_at !== null;
  const cleanupQueued = async (did: string) => (await db.sql`SELECT 1 FROM monitor_receiver_cleanup WHERE did=${did}`).length === 1;

  it("lets a provider deregister with its own credential, after which its origin can register again", async () => {
    const t = setup({ providerOrigin: "https://svr.leaving.example", webOrigin: "https://leaving.example" });
    const issued = await register(t);
    const did = await enroll(issued.providerId!, t.request.providerOrigin);
    const api = createProviderDeregistrationApi(providers, receiver);
    const leave = async (body: unknown, token = issued.token) => {
      const response = await api.fetch(new Request(monitorOrigin + "/api/v1/providers/deregister", { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect((await leave({ providerOrigin: t.request.providerOrigin }, randomBytes(32).toString("base64url"))).status).toBe(401);
    expect((await leave({ providerOrigin: "https://svr.other.example" })).status).toBe(409);
    expect((await leave({ providerOrigin: t.request.providerOrigin, reason: "x" })).status).toBe(400);
    expect(await stopped(did)).toBe(false);

    receiverDown = true; // retired, but the receiver still accepts the old credential: report it so the caller retries
    expect((await leave({ providerOrigin: t.request.providerOrigin })).status).toBe(503);
    expect(await stopped(did)).toBe(true);
    expect(await cleanupQueued(did)).toBe(true);
    receiverDown = false;
    const left = await leave({ providerOrigin: t.request.providerOrigin });
    expect(left).toEqual({ status: 200, body: { providerId: issued.providerId, providerOrigin: t.request.providerOrigin,
      deregistered: true, stoppedIdentities: 0 } });
    expect(provisioned.at(-1)).toMatchObject({ providerId: issued.providerId, enabled: false });
    const provisions = provisioned.length;
    expect((await leave({ providerOrigin: t.request.providerOrigin })).status).toBe(200); // idempotent
    expect(provisioned).toHaveLength(provisions);
    await expect(providers.authenticate(new Request(monitorOrigin, { headers: { Authorization: "Bearer " + issued.token } })))
      .rejects.toThrow("disabled");

    // The same origin registers again: a new registration with new credentials.
    const again = await register(setup({ providerOrigin: t.request.providerOrigin, webOrigin: "https://leaving.example" }));
    expect(again.providerId).not.toBe(issued.providerId);
    expect(again.token).not.toBe(issued.token);
    expect(provisioned.at(-1)).toMatchObject({ providerId: again.providerId, enabled: true });
  });

  it("replaces an active registration only through the registered operator email", async () => {
    const origin = "https://svr.rebuilt.example";
    const first = await register(setup({ providerOrigin: origin }));
    const did = await enroll(first.providerId!, origin);

    const stranger = setup({ providerOrigin: origin, operatorEmail: "attacker@elsewhere.example" });
    await stranger.publish();
    const sent = codes.length;
    const refused = await stranger.post();
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toContain("provider.example"); // the email on file is not revealed
    expect(codes).toHaveLength(sent);
    expect(await stopped(did)).toBe(false);

    const rebuilt = setup({ providerOrigin: origin, operatorEmail: "ops@provider.example" }); // case-insensitive match
    await rebuilt.publish();
    expect((await rebuilt.post()).status).toBe(202);
    expect(codes.at(-1)).toMatchObject({ email: "ops@provider.example", providerOrigin: origin });
    expect(await stopped(did)).toBe(false); // nothing changes before the code is confirmed
    receiverDown = true;
    expect((await rebuilt.post({ operatorCode: codes.at(-1)!.code })).status).toBe(503);
    receiverDown = false;
    const second = await rebuilt.post({ operatorCode: codes.at(-1)!.code });
    expect(second.status).toBe(200);
    expect(second.body.providerId).not.toBe(first.providerId);
    expect(await stopped(did)).toBe(true);
    expect(await cleanupQueued(did)).toBe(true);
    const records = provisioned.filter(record => record.providerOrigin === origin).slice(-2);
    expect(records).toEqual([expect.objectContaining({ providerId: first.providerId, enabled: false }),
      expect.objectContaining({ providerId: second.body.providerId, enabled: true })]);
    await expect(providers.authenticate(new Request(monitorOrigin, { headers: { Authorization: "Bearer " + first.token } })))
      .rejects.toThrow();
    expect((await db.sql`SELECT id FROM monitor_enrollment_providers WHERE provider_origin=${origin} AND retired_at IS NULL`)
      .map((row: { id: string }) => row.id)).toEqual([second.body.providerId]);
  });

  it("does not let a registration replace one the monitor operator disabled", async () => {
    const origin = "https://svr.suspended.example";
    const first = await register(setup({ providerOrigin: origin }));
    await providers.setEnabled(first.providerId!, false);
    const again = setup({ providerOrigin: origin });
    await again.publish();
    expect(await again.post()).toMatchObject({ status: 409, body: { error: expect.stringContaining("disabled") } });
  });
});
