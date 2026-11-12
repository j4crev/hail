import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { EmailBridgeConverter } from "../src/bridge/converter.js";
import { createDkimCheck } from "../src/bridge/dkim.js";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { EmailAliases } from "../src/bridge/aliases.js";
import { EmailBridgeIntake } from "../src/bridge/intake.js";
import { EmailBridgeUnsubscriber } from "../src/bridge/unsubscribe.js";
import { DELETIONS_PATH, registerEmailBridgeIntakeRoutes } from "../src/bridge/routes.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("alias removal cleanup", () => {
  let db: ProviderDatabase;
  beforeAll(async () => { db = new ProviderDatabase(process.env.DATABASE_URL!); await db.migrate(); });
  afterAll(async () => { await db?.close(); });
  async function alias() {
    const owner = randomUUID();
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${owner},${randomUUID()},${owner + "@provider.example"},${"did:plc:" + Array.from(randomBytes(24), byte => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")},'active',now(),${randomBytes(32)},'public')`;
    const service = new EmailAliases(db.sql, "in.example");
    return { owner, service, alias: await service.create(owner, { label: "News" }) };
  }
  async function metadata(id: string, list: string, url: string, accepted: string) {
    await db.sql`INSERT INTO email_bridge_intake(id,alias_id,dedupe_digest,size,received_at,accepted_at,state,message_id,diagnostics)
      VALUES(${randomUUID()},${id},${randomBytes(32)},10,now(),${accepted}::timestamptz,'delivered',${randomUUID()},
        ${JSON.stringify({ dkim: { authentication: "dkim-aligned", unsubscribe: { listKey: list.repeat(64), url } } })}::text::jsonb)`;
  }
  it("backfills old deletions and refuses a rollback that would lose permanent edge records", async () => {
    const { alias: a } = await alias();
    const script = await Bun.file(new URL("../migrations/rollback/0125_email_bridge_unsubscribe.sql", import.meta.url)).text();
    const connection = await db.sql.reserve();
    try { await connection.unsafe(script); } finally { connection.release(); }
    await db.sql`UPDATE email_bridge_aliases SET state = 'deleted', deleted_at = now() WHERE id = ${a.id}`;
    await db.migrate();
    expect((await new EmailBridgeIntake(db.sql, "in.example").deletions("0")).some(d => d.localPart === a.address.split("@")[0])).toBe(true);
    const rollback = await db.sql.reserve();
    try { await expect(rollback.unsafe(script)).rejects.toThrow("Permanent edge deletion records would be lost"); }
    finally { await rollback`ROLLBACK`; rollback.release(); }
  });
  it("captures signed metadata during real conversion and queues it before cancelling converted mail", async () => {
    const { owner, service, alias: a } = await alias();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const message = "From: editor@news.example\r\nSubject: News\r\nList-Unsubscribe: <https://news.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nHello\r\n";
    const signed = await dkimSign(message, { headerList: "from:list-unsubscribe:list-unsubscribe-post", signatureData: [
      { signingDomain: "news.example", selector: "s", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }] });
    const intake = new EmailBridgeIntake(db.sql, "in.example");
    await intake.submit({ recipient: a.address, raw: new TextEncoder().encode(signed.signatures + message), receivedAt: new Date() });
    const converter = new EmailBridgeConverter(db.sql, { resolveRemote: async () => null,
      checkDkim: createDkimCheck(async () => [[`v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`]]) });
    expect(await converter.workOne()).toBe(true);
    expect(await service.remove(owner, a.id, true)).toBe(1);
    const [row] = await db.sql`SELECT state, raw, diagnostics #> '{dkim,unsubscribe}' AS target FROM email_bridge_intake WHERE alias_id = ${a.id}`;
    expect(row).toMatchObject({ state: "dead", raw: null, target: null });
    await new EmailBridgeUnsubscriber(db.sql, async () => new Response(null, { status: 204 })).workOne();
  });
  it("requires consent, preserves delivered mail records, and never publishes temporary refusals", async () => {
    const { owner, service, alias: a } = await alias();
    const intake = new EmailBridgeIntake(db.sql, "in.example");
    await service.update(owner, a.id, { state: "paused" });
    expect(await intake.check(a.address)).toBe("reject");
    expect((await intake.deletions("0")).some(row => row.localPart === a.address.split("@")[0])).toBe(false);
    await metadata(a.id, "a", "https://news.example/u", "2026-11-01");
    expect(await service.remove(owner, a.id)).toBe(0);
    expect(await db.sql`SELECT id FROM email_bridge_unsubscriptions WHERE alias_id = ${a.id}`).toHaveLength(0);
    expect([...(await db.sql`SELECT state, diagnostics #> '{dkim,unsubscribe}' AS target FROM email_bridge_intake WHERE alias_id = ${a.id}`)])
      .toEqual([expect.objectContaining({ state: "delivered", target: null })]);
    expect((await intake.deletions("0")).some(row => row.localPart === a.address.split("@")[0])).toBe(true);
  });
  it("atomically deletes shared aliases and queues the latest endpoint per list with explicit consent", async () => {
    const { owner, service, alias: a } = await alias();
    await metadata(a.id, "a", "https://news.example/old", "2026-11-01");
    await metadata(a.id, "a", "https://news.example/latest", "2026-11-02");
    await metadata(a.id, "b", "https://other.example/u", "2026-11-01");
    await metadata(a.id, "c", "http://unsafe.example/u", "2026-11-01");
    await expect(service.remove(randomUUID(), a.id, true)).rejects.toMatchObject({ status: 404 });
    expect(await service.remove(owner, a.id, true)).toBe(2);
    expect(await new EmailBridgeIntake(db.sql, "in.example").check(a.address)).toBe("reject");
    expect((await db.sql<{url: string}[]>`SELECT url FROM email_bridge_unsubscriptions WHERE alias_id = ${a.id} ORDER BY url`).map(r => r.url))
      .toEqual(["https://news.example/latest", "https://other.example/u"]);
    await expect(service.remove(owner, a.id, true)).rejects.toMatchObject({ status: 404 });
    const requests: Request[] = [];
    const worker = new EmailBridgeUnsubscriber(db.sql, async request => { requests.push(request); return new Response(null, { status: 204 }); });
    while (await worker.workOne()) { /* Drain these two jobs. */ }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe("POST"); expect(request.redirect).toBe("manual");
      expect([...request.headers.keys()]).toEqual(["content-type"]);
      expect(await request.text()).toBe("List-Unsubscribe=One-Click");
    }
    expect([...(await db.sql`SELECT state, url FROM email_bridge_unsubscriptions WHERE alias_id = ${a.id}`)])
      .toEqual([expect.objectContaining({ state: "requested", url: null }), expect.objectContaining({ state: "requested", url: null })]);
  });
  it("bounds transient retries, refuses redirects, and erases tokens on terminal failure", async () => {
    for (const status of [302, 400, 429, 503]) {
      const { owner, service, alias: a } = await alias();
      await metadata(a.id, "d", "https://news.example/u", "2026-11-01");
      await service.remove(owner, a.id, true);
      let attempts = 0;
      const worker = new EmailBridgeUnsubscriber(db.sql, async () => { attempts++; return new Response(null, { status, headers: { location: "https://other.example/redirect" } }); });
      for (let i = 0; i < 6; i++) {
        await db.sql`UPDATE email_bridge_unsubscriptions SET next_attempt_at = now() WHERE alias_id = ${a.id}`;
        await worker.workOne();
      }
      expect(attempts).toBe(status < 429 ? 1 : 5);
      expect([...(await db.sql`SELECT state, url FROM email_bridge_unsubscriptions WHERE alias_id = ${a.id}`)])
        .toEqual([expect.objectContaining({ state: "failed", url: null })]);
    }
  });
  it("authenticates deletion feeds, validates bigint cursors, and returns numeric sequence order", async () => {
    const intake = new EmailBridgeIntake(db.sql, "in.example"), app = new Hono(), token = "T".repeat(43);
    registerEmailBridgeIntakeRoutes(app, intake, token, 1024);
    const call = (body: object, credential = token) => app.request(DELETIONS_PATH, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: JSON.stringify(body) });
    expect((await call({ after: "0" }, "X".repeat(43))).status).toBe(401);
    for (const after of [1, "-1", "01", "9223372036854775808"]) expect((await call({ after })).status).toBe(400);
    for (let i = 0; i < 12; i++) { const { owner, service, alias: a } = await alias(); await service.remove(owner, a.id); }
    const response = await call({ after: "0" });
    expect(response.status).toBe(200);
    const { deletions } = await response.json() as { deletions: { sequence: string; localPart: string }[] };
    expect(deletions.length).toBeGreaterThan(10);
    expect(deletions.map(d => BigInt(d.sequence))).toEqual(deletions.map(d => BigInt(d.sequence)).sort((a, b) => a < b ? -1 : 1));
    const last = deletions.at(-1)!;
    expect(await (await call({ after: last.sequence })).json()).toEqual({ deletions: [] });
  });
  it("does not publish a later committed deletion ahead of an earlier in-flight deletion", async () => {
    const first = await alias(), second = await alias();
    const connection = await db.sql.reserve();
    try {
      await connection`BEGIN`;
      await connection`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':email-deletions', 0))`;
      await connection`INSERT INTO email_bridge_deletions(local_part) VALUES (${first.alias.address.split("@")[0]!})`;
      let complete = false;
      const deleting = second.service.remove(second.owner, second.alias.id).then(() => { complete = true; });
      const edge = new EmailBridgeIntake(db.sql, "in.example");
      expect((await edge.deletions("0")).some(d => d.localPart === first.alias.address.split("@")[0])).toBe(false);
      expect(complete).toBe(false);
      await connection`COMMIT`;
      await deleting;
      const records = await edge.deletions("0");
      expect(records.findIndex(d => d.localPart === first.alias.address.split("@")[0])).toBeLessThan(records.findIndex(d => d.localPart === second.alias.address.split("@")[0]));
    } finally { await connection`ROLLBACK`; connection.release(); }
  });
});
