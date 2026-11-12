import { randomBytes, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderDatabase } from "../src/db/database.js";
import { EmailAliases, EmailBridgeError } from "../src/bridge/aliases.js";
import { DEFAULT_INTAKE_LIMITS, EmailBridgeIntake, type IntakeLimits } from "../src/bridge/intake.js";
import { INTAKE_CHECK_PATH, INTAKE_MESSAGE_PATH, registerEmailBridgeIntakeRoutes } from "../src/bridge/routes.js";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
const DOMAIN = "in.bridge.example";
const message = (id: string | null, body = "Hello"): Uint8Array => new TextEncoder().encode(
  `From: news@sender.example\r\n${id === null ? "" : `Message-ID: <${id}>\r\n`}Subject: Issue\r\n\r\n${body}\r\n`);

integration("email bridge aliases and intake", () => {
  let admin: SQL, db: ProviderDatabase, schema: string;
  beforeAll(async () => {
    admin = new SQL(process.env.DATABASE_URL!); schema = `bridge_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new ProviderDatabase(url.toString()); await db.migrate();
  });
  afterAll(async () => {
    if (db) await db.close();
    if (admin) { if (schema) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.close(); }
  });

  async function account(): Promise<string> {
    const id = randomUUID(), did = `did:plc:${Array.from(randomBytes(24), byte => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`;
    await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${id + "@provider.example.com"},${did},'active',now(),${randomBytes(32)},'public')`;
    return id;
  }
  const aliases = (limit = 50) => new EmailAliases(db.sql, DOMAIN, { maxAliasesPerAccount: limit });
  const intake = (limits: Partial<IntakeLimits> = {}) => new EmailBridgeIntake(db.sql, DOMAIN, { ...DEFAULT_INTAKE_LIMITS, ...limits });
  const submit = (service: EmailBridgeIntake, recipient: string, raw: Uint8Array) =>
    service.submit({ recipient, raw, receivedAt: new Date("2026-11-11T12:00:00Z"), envelopeSender: "bounce@sender.example", sourceAddress: "192.0.2.10" });
  const status = async (code: () => Promise<unknown>) => code().then(() => 200, error => (error as EmailBridgeError).status);

  it("creates unguessable aliases and lists, renames, pauses and removes them", async () => {
    const owner = await account(), service = aliases();
    const first = await service.create(owner, { label: "  Field​   Notes " });
    expect(first).toMatchObject({ label: "Field Notes", state: "active", messageCount: 0, lastReceivedAt: null });
    expect(first.address).toMatch(/^[a-z2-7]{12}@in\.bridge\.example$/);
    const second = await service.create(owner, { label: "Second" });
    expect(second.address).not.toBe(first.address);
    expect((await service.list(owner)).map(alias => alias.id)).toEqual([second.id, first.id]);

    expect(await service.update(owner, first.id, { label: "Renamed" })).toMatchObject({ label: "Renamed", state: "active" });
    expect(await service.update(owner, first.id, { state: "paused" })).toMatchObject({ label: "Renamed", state: "paused" });
    await service.remove(owner, first.id);
    expect((await service.list(owner)).map(alias => alias.id)).toEqual([second.id]);
    expect(await status(() => service.remove(owner, first.id))).toBe(404);
    expect(await status(() => service.update(owner, first.id, { state: "active" }))).toBe(404);
  });

  it("isolates accounts, validates input and enforces the alias cap", async () => {
    const owner = await account(), other = await account(), service = aliases(2);
    const alias = await service.create(owner, { label: "Mine" });
    expect(await status(() => service.update(other, alias.id, { label: "Theirs" }))).toBe(404);
    expect(await status(() => service.remove(other, alias.id))).toBe(404);
    expect(await status(() => service.remove(owner, "not-an-id"))).toBe(404);
    expect(await service.list(other)).toEqual([]);
    for (const label of ["", "   ", 7, "x".repeat(161)]) expect(await status(() => service.create(owner, { label }))).toBe(400);
    expect(await status(() => service.update(owner, alias.id, { state: "deleted" }))).toBe(400);
    await service.create(owner, { label: "Second" });
    expect(await status(() => service.create(owner, { label: "Third" }))).toBe(409);
    // Removing one frees a place; the cap counts live aliases only.
    await service.remove(owner, alias.id);
    await service.create(owner, { label: "Third" });
  });

  it("answers the pre-acceptance check without distinguishing why mail is refused", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const live = await service.create(owner, { label: "Live" }), paused = await service.create(owner, { label: "Paused" });
    const gone = await service.create(owner, { label: "Gone" });
    await service.update(owner, paused.id, { state: "paused" });
    await service.remove(owner, gone.id);
    expect(await edge.check(live.address)).toBe("accept");
    expect(await edge.check(`  ${live.address.toUpperCase()} `)).toBe("accept");
    for (const recipient of [paused.address, gone.address, `aaaaaaaaaaaa@${DOMAIN}`, live.address.replace(DOMAIN, "elsewhere.example"),
      `postmaster@${DOMAIN}`, "not-an-address", ""]) expect(await edge.check(recipient)).toBe("reject");
  });

  it("stores an accepted message once and recognizes resends", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const alias = await service.create(owner, { label: "News" });
    const raw = message("issue-1@sender.example");
    expect(await submit(edge, alias.address, raw)).toBe("accepted");
    // The same Message-ID with different bytes, as after a relay adds a header, is still a resend.
    expect(await submit(edge, alias.address, message("issue-1@sender.example", "Changed"))).toBe("duplicate");
    expect(await submit(edge, alias.address, message("issue-2@sender.example"))).toBe("accepted");
    // Without a Message-ID the bytes identify the message.
    expect(await submit(edge, alias.address, message(null))).toBe("accepted");
    expect(await submit(edge, alias.address, message(null))).toBe("duplicate");
    expect(await submit(edge, alias.address, message(null, "Different"))).toBe("accepted");

    const rows = await db.sql<{ state: string; size: number; raw: Uint8Array; envelope_sender: string; source: string }[]>`
      SELECT intake.state, intake.size, intake.raw, intake.envelope_sender, host(intake.source_address) AS source
      FROM email_bridge_intake intake JOIN email_bridge_aliases alias ON alias.id = intake.alias_id
      WHERE alias.account_id = ${owner} ORDER BY intake.accepted_at`;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ state: "queued", size: raw.length, envelope_sender: "bounce@sender.example", source: "192.0.2.10" });
    expect(Buffer.from(rows[0]!.raw).equals(Buffer.from(raw))).toBe(true);
    expect((await service.list(owner))[0]).toMatchObject({ messageCount: 4, lastReceivedAt: new Date("2026-11-11T12:00:00Z") });
  });

  it("keeps one alias's messages apart from another's", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const one = await service.create(owner, { label: "One" }), two = await service.create(owner, { label: "Two" });
    expect(await submit(edge, one.address, message("shared@sender.example"))).toBe("accepted");
    expect(await submit(edge, two.address, message("shared@sender.example"))).toBe("accepted");
  });

  it("refuses unusable recipients and oversized or empty messages", async () => {
    const owner = await account(), service = aliases(), edge = intake({ maxMessageBytes: 200 });
    const alias = await service.create(owner, { label: "News" }), paused = await service.create(owner, { label: "Paused" });
    await service.update(owner, paused.id, { state: "paused" });
    expect(await submit(edge, paused.address, message("a@sender.example"))).toBe("reject");
    expect(await submit(edge, `aaaaaaaaaaaa@${DOMAIN}`, message("a@sender.example"))).toBe("reject");
    expect(await submit(edge, alias.address, new Uint8Array())).toBe("reject");
    expect(await submit(edge, alias.address, message("big@sender.example", "x".repeat(300)))).toBe("reject");
    expect((await service.list(owner)).every(entry => entry.messageCount === 0)).toBe(true);
  });

  it("defers when an alias, an account or its pending queue is over its limit", async () => {
    const service = aliases();
    const hourly = await account(), hourlyAlias = await service.create(hourly, { label: "Busy" }), hourlyEdge = intake({ aliasHourly: 2 });
    expect(await submit(hourlyEdge, hourlyAlias.address, message("1@s.example"))).toBe("accepted");
    expect(await submit(hourlyEdge, hourlyAlias.address, message("2@s.example"))).toBe("accepted");
    expect(await hourlyEdge.check(hourlyAlias.address)).toBe("defer");
    expect(await submit(hourlyEdge, hourlyAlias.address, message("3@s.example"))).toBe("defer");
    // A resend of something already held is acknowledged so the sender stops retrying.
    expect(await submit(hourlyEdge, hourlyAlias.address, message("1@s.example"))).toBe("duplicate");
    // Another alias of the same account has its own hourly allowance.
    const quiet = await service.create(hourly, { label: "Quiet" });
    expect(await submit(hourlyEdge, quiet.address, message("1@s.example"))).toBe("accepted");

    const daily = await account(), dailyEdge = intake({ accountDaily: 2 });
    const a = await service.create(daily, { label: "A" }), b = await service.create(daily, { label: "B" });
    expect(await submit(dailyEdge, a.address, message("1@s.example"))).toBe("accepted");
    expect(await submit(dailyEdge, b.address, message("1@s.example"))).toBe("accepted");
    expect(await submit(dailyEdge, a.address, message("2@s.example"))).toBe("defer");

    const pending = await account(), pendingAlias = await service.create(pending, { label: "Slow" });
    const pendingEdge = intake({ accountPendingBytes: 100 });
    expect(await submit(pendingEdge, pendingAlias.address, message("1@s.example", "x".repeat(120)))).toBe("accepted");
    expect(await submit(pendingEdge, pendingAlias.address, message("2@s.example"))).toBe("defer");
  });

  it("discards queued mail when its alias is removed and refuses more", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const alias = await service.create(owner, { label: "Leaving" });
    expect(await submit(edge, alias.address, message("1@s.example"))).toBe("accepted");
    await service.remove(owner, alias.id);
    const rows = await db.sql<{ state: string; raw: Uint8Array | null; failure: string }[]>`
      SELECT state, raw, failure FROM email_bridge_intake WHERE alias_id = ${alias.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ state: "dead", raw: null, failure: "alias deleted" });
    expect(await submit(edge, alias.address, message("2@s.example"))).toBe("reject");
  });

  it("serializes concurrent deliveries of one message", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const alias = await service.create(owner, { label: "Race" });
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(edge, alias.address, message("race@s.example"))));
    expect(results.filter(result => result === "accepted")).toHaveLength(1);
    expect(results.filter(result => result === "duplicate")).toHaveLength(5);
  });

  it("refuses mail and new aliases for an account that is moving to another provider", async () => {
    const owner = await account(), service = aliases(), edge = intake();
    const alias = await service.create(owner, { label: "Moving" });
    await db.sql`INSERT INTO provider_migration_fences (did, account_id, transfer_id, destination_service_base, state)
      SELECT did, id, ${randomUUID()}, 'https://destination.example.com/hail', 'fenced' FROM provider_accounts WHERE id = ${owner}`;
    expect(await edge.check(alias.address)).toBe("reject");
    expect(await submit(edge, alias.address, message("1@s.example"))).toBe("reject");
    expect(await status(() => service.create(owner, { label: "Late" }))).toBe(409);
  });

  describe("ingress contract routes", () => {
    const token = randomBytes(32).toString("base64url");
    const app = () => {
      const hono = new Hono();
      registerEmailBridgeIntakeRoutes(hono, intake(), token, 2048);
      return hono;
    };
    const post = (path: string, headers: Record<string, string>, body: string | Uint8Array) =>
      app().request(`https://provider.example.com${path}`, { method: "POST", headers, body: body as BodyInit });
    const auth = { Authorization: `Bearer ${token}` };
    const envelope = (recipient: string) => ({ ...auth, "Content-Type": "message/rfc822", "Bridge-Recipient": recipient, "Bridge-Received-At": "1794400000" });

    it("requires the intake credential, method and media types", async () => {
      const json = { "Content-Type": "application/json" };
      expect((await app().request(`https://provider.example.com${INTAKE_CHECK_PATH}`)).status).toBe(405);
      expect((await post(INTAKE_CHECK_PATH, json, "{}")).status).toBe(401);
      expect((await post(INTAKE_CHECK_PATH, { ...json, Authorization: `Bearer ${randomBytes(32).toString("base64url")}` }, "{}")).status).toBe(401);
      expect((await post(INTAKE_CHECK_PATH, { ...json, Authorization: "Bearer short" }, "{}")).status).toBe(401);
      expect((await post(INTAKE_CHECK_PATH, { ...auth, "Content-Type": "text/plain" }, "{}")).status).toBe(415);
      expect((await post(INTAKE_CHECK_PATH, { ...auth, ...json }, "{}")).status).toBe(400);
      expect((await post(INTAKE_CHECK_PATH, { ...auth, ...json }, '{"recipient":"a","recipient":"b"}')).status).toBe(400);
      expect((await post(INTAKE_MESSAGE_PATH, { "Content-Type": "message/rfc822" }, "x")).status).toBe(401);
      expect((await post(INTAKE_MESSAGE_PATH, { ...auth, "Content-Type": "application/json" }, "x")).status).toBe(415);
      expect((await post(INTAKE_MESSAGE_PATH, { ...auth, "Content-Type": "message/rfc822" }, "x")).status).toBe(400);
    });

    it("checks and accepts mail for a live alias", async () => {
      const owner = await account(), alias = await aliases().create(owner, { label: "Routes" });
      const check = await post(INTAKE_CHECK_PATH, { ...auth, "Content-Type": "application/json" }, JSON.stringify({ recipient: alias.address }));
      expect(check.status).toBe(200);
      expect(check.headers.get("Cache-Control")).toBe("no-store");
      expect(await check.json()).toEqual({ result: "accept" });
      const unknown = await post(INTAKE_CHECK_PATH, { ...auth, "Content-Type": "application/json" }, JSON.stringify({ recipient: `aaaaaaaaaaaa@${DOMAIN}` }));
      expect(await unknown.json()).toEqual({ result: "reject" });

      const raw = message("route-1@s.example");
      const accepted = await post(INTAKE_MESSAGE_PATH, { ...envelope(alias.address), "Bridge-Envelope-Sender": "bounce@s.example", "Bridge-Source-Address": "2001:db8::1" }, raw);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ result: "accepted" });
      expect(await (await post(INTAKE_MESSAGE_PATH, envelope(alias.address), raw)).json()).toEqual({ result: "duplicate" });
      const oversized = await post(INTAKE_MESSAGE_PATH, envelope(alias.address), message("route-2@s.example", "x".repeat(4096)));
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({ result: "reject" });
      const [row] = await db.sql<{ source: string; received_at: Date }[]>`
        SELECT host(source_address) AS source, received_at FROM email_bridge_intake WHERE alias_id = ${alias.id}`;
      expect(row).toEqual({ source: "2001:db8::1", received_at: new Date(1_794_400_000_000) });
    });
  });
});
