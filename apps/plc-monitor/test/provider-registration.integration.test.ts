import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorDatabase } from "../src/database.js";
import { EnrollmentProviders } from "../src/providers.js";
import { MonitorSigner } from "../src/signing.js";
import { createProviderRegistrationApi, registrationDocument, REGISTRATION_PATH } from "../src/provider-registration.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("self-service monitor provider registration", () => {
  let db: MonitorDatabase, providers: EnrollmentProviders;
  const monitorOrigin = "https://monitor.example", signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith("/hail_test_")) throw Error("Use disposable database runner");
    db = new MonitorDatabase(process.env.DATABASE_URL!); await db.migrate(); providers = new EnrollmentProviders(db.sql);
  });
  afterAll(async () => { await db?.close(); });
  it("requires control of both origins, issues an isolated credential, and safely retries lost responses", async () => {
    const input = { providerOrigin: "https://provider.example", alertOrigin: "https://alerts.example",
      registrationSecret: randomBytes(32).toString("base64url"), expiresAt: Math.floor(Date.now() / 1000) + 600 };
    const document = await registrationDocument({ ...input, monitorApiOrigin: monitorOrigin });
    const calls: string[] = [], published = new Map([[input.providerOrigin + REGISTRATION_PATH, document]]);
    const api = createProviderRegistrationApi(providers, signer, monitorOrigin, async url => {
      calls.push(url); return published.has(url) ? Response.json(published.get(url)) : new Response(null, { status: 404 });
    });
    const post = (body: unknown) => api.fetch(new Request(monitorOrigin + "/api/v1/providers/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await post(input)).status).toBe(409); // receiver has not opted in
    expect(await db.sql`SELECT id FROM monitor_enrollment_providers`).toHaveLength(0);
    published.set(input.alertOrigin + REGISTRATION_PATH, document);
    expect((await post({ ...input, registrationSecret: document.registrationHash })).status).toBe(409);
    const response = await post(input);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.token).not.toBe(input.registrationSecret);
    expect((await (await post(input)).json()).token).toBe(result.token);
    expect(calls.every(url => url.endsWith(REGISTRATION_PATH))).toBe(true);
    expect((await providers.authenticate(new Request(monitorOrigin, { headers: { Authorization: "Bearer " + result.token } }))).provider_origin).toBe(input.providerOrigin);
    const stored = (await db.sql`SELECT * FROM monitor_enrollment_providers WHERE id=${result.providerId}`)[0];
    expect(JSON.stringify(stored)).not.toContain(result.token);
    expect(JSON.stringify(stored)).not.toContain(input.registrationSecret);
    await providers.setEnabled(result.providerId, false);
    expect((await post(input)).status).toBe(409); // cannot resurrect revoked credentials
    expect((await post({ ...input, expiresAt: 1 })).status).toBe(400);
  });
  it("refuses invalid origins before any outbound requests", async () => {
    let calls = 0;
    const api = createProviderRegistrationApi(providers, signer, monitorOrigin, async () => { calls++; throw Error(); });
    for (const providerOrigin of ["http://provider.example", "https://127.0.0.1", "https://provider.example:8443", "https://provider.example/path"]) {
      const response = await api.fetch(new Request(monitorOrigin + "/api/v1/providers/register", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          providerOrigin, alertOrigin: "https://alerts.example", registrationSecret: randomBytes(32).toString("base64url"),
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }),
      }));
      expect(response.status).toBe(400);
    }
    expect(calls).toBe(0);
  });
});
