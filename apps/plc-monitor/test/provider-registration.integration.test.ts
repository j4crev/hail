import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorDatabase } from "../src/database.js";
import { hash } from "../src/http.js";
import { EnrollmentProviders } from "../src/providers.js";
import { MonitorSigner } from "../src/signing.js";
import { createProviderRegistrationApi, registrationDocument, REGISTRATION_PATH } from "../src/provider-registration.js";
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

  function setup(input: { providerOrigin: string; webOrigin?: string }) {
    const request = { ...input, operatorEmail: "Ops@Provider.Example", registrationSecret: randomBytes(32).toString("base64url"),
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
});
