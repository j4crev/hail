import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { P256Keypair } from "@atproto/crypto";
import { didForCreateOp, signOperation, validateOperationLog } from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { MonitorDatabase } from "../src/database.js";
import { EnrollmentProviders } from "../src/providers.js";
import { PlcMonitor } from "../src/monitor.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("provider enrollment isolation and capacity", () => {
  let db: MonitorDatabase, providers: EnrollmentProviders;
  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith("/hail_test_")) throw Error("Use disposable database runner");
    db = new MonitorDatabase(process.env.DATABASE_URL!); await db.migrate();
    providers = new EnrollmentProviders(db.sql);
  });
  afterAll(async () => { await db?.close(); });
  const request = (token: string) => new Request("https://monitor.example/api/v1/onboarding", {
    headers: { Authorization: `Bearer ${token}` },
  });
  async function provider() {
    return providers.create(`https://p-${crypto.randomUUID()}.example`, "https://alerts.example");
  }
  it("stores hashes, rotates independently and enforces persistent per-provider limits", async () => {
    const a = await provider(), b = await provider();
    const stored = (await db.sql`SELECT token_hash FROM monitor_enrollment_providers WHERE id=${a.id}`)[0];
    expect(stored.token_hash).not.toBe(a.token);
    await db.sql`UPDATE monitor_enrollment_providers SET requests_per_minute=1 WHERE id=${a.id}`;
    expect((await providers.authenticate(request(a.token))).id).toBe(a.id);
    await expect(providers.authenticate(request(a.token))).rejects.toMatchObject({ status: 429 });
    expect((await providers.authenticate(request(b.token))).id).toBe(b.id);
    const rotated = await providers.rotate(b.id);
    await expect(providers.authenticate(request(b.token))).rejects.toMatchObject({ status: 401 });
    expect((await providers.authenticate(request(rotated.token))).id).toBe(b.id);
    await providers.setEnabled(b.id, false);
    await expect(providers.authenticate(request(rotated.token))).rejects.toMatchObject({ status: 403 });
  });
  async function identity(origin: string) {
    const key = await P256Keypair.create();
    const operation = await signOperation({ type: "plc_operation", prev: null, rotationKeys: [key.did()],
      services: { hail: { type: "HailMessaging", endpoint: origin + "/hail" } }, verificationMethods: {}, alsoKnownAs: [] }, key);
    const did = await didForCreateOp(operation), cid = (await cidForCbor(operation)).toString();
    const state = (await validateOperationLog(did, [operation]))!;
    const createdAt = new Date(Date.now() - 1000).toISOString();
    const monitor = new PlcMonitor(db.sql, {
      async getAuditableLog() { return [{ did, cid, operation, nullified: false, createdAt }]; },
      async getOperationLog() { return [operation]; }, async getDocumentData() { return state; }, async exportAfter() { return []; },
    });
    return { did, cid, state, monitor };
  }
  it("enforces ownership, atomic quotas, exact retries and revocation without stopping polling", async () => {
    const a = await provider(), b = await provider(), webhook = a.alertOrigin + "/hail/signup";
    await db.sql`UPDATE monitor_enrollment_providers SET max_identities=1 WHERE id=${a.id}`;
    const x = await identity(a.providerOrigin), y = await identity(a.providerOrigin);
    const enrolled = await Promise.allSettled([x, y].map(i => i.monitor.enroll(i.did, i.cid, webhook, i.state, a.id)));
    expect(enrolled.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const ok = enrolled[0]!.status === "fulfilled" ? x : y;
    await ok.monitor.enroll(ok.did, ok.cid, webhook, ok.state, a.id); // retry does not consume quota
    await expect(ok.monitor.enroll(ok.did, ok.cid, webhook, ok.state, b.id)).rejects.toThrow();
    await expect(ok.monitor.stopManaged(ok.did, ok.cid, a.providerOrigin, webhook, b.id)).rejects.toThrow();
    await providers.setEnabled(a.id, false);
    await expect(ok.monitor.enroll(ok.did, ok.cid, webhook, ok.state, a.id)).rejects.toMatchObject({ status: 403 });
    await ok.monitor.pollDid(ok.did);
    expect((await db.sql`SELECT stopped_at,last_polled_at FROM monitored_dids WHERE did=${ok.did}`)[0]).toMatchObject({ stopped_at: null, last_polled_at: expect.any(Date) });
  });
  it("does not let a provider claim an existing manual enrollment", async () => {
    const a = await provider(), x = await identity(a.providerOrigin), webhook = a.alertOrigin + "/hail/signup";
    await x.monitor.enroll(x.did, x.cid, webhook, x.state);
    await expect(x.monitor.enroll(x.did, x.cid, webhook, x.state, a.id)).rejects.toMatchObject({ status: 409 });
  });
  it("imports only matching legacy consumer enrollments without rewriting retained evidence", async () => {
    const origin = "https://legacy.example", alerts = "https://legacy-alerts.example";
    const x = await identity(origin), manual = await identity(origin);
    await x.monitor.enroll(x.did, x.cid, alerts + "/hail/signup", x.state);
    await manual.monitor.enroll(manual.did, manual.cid, alerts + "/hail", manual.state);
    const before = await db.sql`SELECT enrolled_at,expected_cid,expected_state FROM monitored_dids WHERE did=${x.did}`;
    const encoded = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn([process.execPath, "src/cli/providers.ts", "import-legacy"], {
        cwd: new URL("../", import.meta.url).pathname,
        env: { ...process.env, MONITOR_ENROLLMENT_TOKEN: encoded, MONITOR_ENROLLMENT_PROVIDER: origin,
          MONITOR_ENROLLMENT_ALERT_ORIGIN: alerts }, stdout: "pipe", stderr: "pipe",
      });
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, errors).toBe(0); expect(output).not.toContain(encoded);
    }
    expect(await db.sql`SELECT enrolled_at,expected_cid,expected_state FROM monitored_dids WHERE did=${x.did}`).toEqual(before);
    expect((await db.sql`SELECT enrollment_provider_id FROM monitored_dids WHERE did=${x.did}`)[0]!.enrollment_provider_id).not.toBeNull();
    expect((await db.sql`SELECT enrollment_provider_id FROM monitored_dids WHERE did=${manual.did}`)[0]!.enrollment_provider_id).toBeNull();
    const connection = await db.sql.reserve();
    try {
      await expect(connection.unsafe(await Bun.file(new URL("../migrations/rollback/0009_enrollment_providers.sql", import.meta.url)).text()))
        .rejects.toThrow("ownership evidence prevents rollback");
      await connection.unsafe("ROLLBACK");
    } finally { connection.release(); }
    expect((await providers.authenticate(request(encoded))).provider_origin).toBe(origin);
  });
});
