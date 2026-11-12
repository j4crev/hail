import { afterEach, describe, expect, it, vi } from "vitest";
import { handleEmail, handleRetry, MAX_ATTEMPTS, type Env, type IncomingEmail, type RetryBody, type RetryMessage } from "../deploy/cloudflare-email-worker/worker.js";

const raw = new TextEncoder().encode("From: a@b.example\r\nMessage-ID: <1@b.example>\r\n\r\nHello\r\n");
function email(to = "kq4tzx7m2fpa@haili.email", bytes = raw, rawSize = bytes.length) {
  const rejected: string[] = [];
  const message: IncomingEmail = { from: "bounce@b.example", to, rawSize, setReject: reason => { rejected.push(reason); },
    raw: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  return { message, rejected };
}
function environment() {
  const stored = new Map<string, Uint8Array>(), queued: { body: RetryBody; delaySeconds?: number }[] = [];
  const env: Env = { PROVIDER_ORIGIN: "https://svr.provider.example", ALIAS_DOMAIN: "haili.email", INTAKE_TOKEN: "T".repeat(43),
    PENDING: { put: async (key, value) => { stored.set(key, value); }, get: async key => { const v = stored.get(key); return v ? { arrayBuffer: async () => v.slice().buffer } : null; },
      delete: async key => { stored.delete(key); } },
    RETRY: { send: async (body, options) => { queued.push({ body, ...options }); } } };
  return { env, stored, queued };
}
type Answer = { status?: number; result?: string } | "down";
function provider(check: Answer, submit: Answer = { result: "accepted" }) {
  const calls: { path: string; headers: Headers; body: Uint8Array; redirect: RequestRedirect | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, answer = path.endsWith("/check") ? check : submit;
    // The Workers runtime accepts only "follow" and "manual"; "error" throws a TypeError.
    if (init.redirect !== "follow" && init.redirect !== "manual") throw new TypeError("Invalid redirect value");
    calls.push({ path, headers: new Headers(init.headers), body: new Uint8Array(await new Response(init.body).arrayBuffer()), redirect: init.redirect });
    if (answer === "down") throw new TypeError("fetch failed");
    return Response.json({ result: answer.result }, { status: answer.status ?? 200 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("email handler", () => {
  it("checks, then submits the unmodified message with the contract headers", async () => {
    const calls = provider({ result: "accept" }), { env, queued } = environment(), { message, rejected } = email("KQ4TZX7M2FPA@haili.email ");
    await handleEmail(message, env);
    expect(rejected).toEqual([]);
    expect(calls.map(call => call.path)).toEqual(["/email-bridge/v1/intake/check", "/email-bridge/v1/intake/messages"]);
    expect(calls.map(call => call.redirect)).toEqual(["manual", "manual"]);
    expect(JSON.parse(new TextDecoder().decode(calls[0]!.body))).toEqual({ recipient: "kq4tzx7m2fpa@haili.email" });
    expect(calls[1]!.body).toEqual(raw);
    expect(Object.fromEntries(calls[1]!.headers)).toMatchObject({ authorization: `Bearer ${"T".repeat(43)}`, "content-type": "message/rfc822",
      "bridge-recipient": "kq4tzx7m2fpa@haili.email", "bridge-envelope-sender": "bounce@b.example" });
    expect(Number(calls[1]!.headers.get("bridge-received-at"))).toBeGreaterThan(1_700_000_000);
    expect(queued).toEqual([]);
  });

  it("refuses other domains, oversized messages, refused aliases and over-limit recipients without reading the body", async () => {
    const { env } = environment();
    for (const [to, check, size, reason] of [
      ["someone@elsewhere.example", { result: "accept" }, raw.length, "No such recipient"],
      ["kq4tzx7m2fpa@haili.email", { result: "accept" }, 11 * 1024 * 1024, "Message too large"],
      ["kq4tzx7m2fpa@haili.email", { result: "reject" }, raw.length, "No such recipient"],
      ["kq4tzx7m2fpa@haili.email", { result: "defer" }, raw.length, "Recipient is not accepting mail right now"],
    ] as const) {
      const calls = provider(check), { message, rejected } = email(to, raw, size);
      await handleEmail(message, env);
      expect(rejected).toEqual([reason]);
      expect(calls.every(call => call.path.endsWith("/check"))).toBe(true);
    }
  });

  it("refuses a message the submission refuses", async () => {
    provider({ result: "accept" }, { result: "reject" });
    const { env, queued } = environment(), { message, rejected } = email();
    await handleEmail(message, env);
    expect(rejected).toEqual(["No such recipient"]);
    expect(queued).toEqual([]);
  });

  it("holds the message for retry when the provider is down or answers unexpectedly", async () => {
    for (const [check, submit] of [["down", { result: "accepted" }], [{ status: 503 }, { result: "accepted" }], [{ status: 308 }, { result: "accepted" }], [{ result: "accept" }, "down"],
      [{ result: "accept" }, { status: 502 }], [{ result: "maybe" }, { result: "accepted" }]] as [Answer, Answer][]) {
      provider(check, submit);
      const { env, stored, queued } = environment(), { message, rejected } = email();
      await handleEmail(message, env);
      expect(rejected).toEqual([]);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ delaySeconds: 60, body: { recipient: "kq4tzx7m2fpa@haili.email", envelopeSender: "bounce@b.example" } });
      expect(stored.get(queued[0]!.body.key)).toEqual(raw);
    }
  });
});

describe("retry consumer", () => {
  function retryMessage(body: RetryBody, attempts: number) {
    const state = { acked: false, retried: null as number | null };
    const message: RetryMessage = { body, attempts, ack: () => { state.acked = true; }, retry: options => { state.retried = options?.delaySeconds ?? 0; } };
    return { message, state };
  }
  async function held() {
    const setup = environment();
    await setup.env.PENDING.put("pending/x", raw);
    return { ...setup, body: { key: "pending/x", recipient: "kq4tzx7m2fpa@haili.email", envelopeSender: "bounce@b.example", receivedAt: 1_794_400_000 } };
  }

  it("delivers a held message and deletes it, or discards it silently when refused", async () => {
    for (const result of ["accepted", "duplicate", "reject"]) {
      const calls = provider({ result: "accept" }, { result }), { env, stored, body } = await held(), { message, state } = retryMessage(body, 1);
      await handleRetry([message], env);
      expect(state).toEqual({ acked: true, retried: null });
      expect(stored.has("pending/x")).toBe(false);
      expect(calls.map(call => call.path)).toEqual(["/email-bridge/v1/intake/messages"]);
      expect(calls[0]!.headers.get("bridge-received-at")).toBe("1794400000");
    }
  });

  it("retries with growing delays while the provider is down or deferring, then gives up", async () => {
    for (const submit of ["down", { result: "defer" }] as Answer[]) {
      provider({ result: "accept" }, submit);
      const { env, stored, body } = await held();
      const first = retryMessage(body, 1), later = retryMessage(body, 5), last = retryMessage(body, MAX_ATTEMPTS);
      await handleRetry([first.message], env);
      await handleRetry([later.message], env);
      expect([first.state.retried, later.state.retried]).toEqual([120, 1920]);
      expect(stored.has("pending/x")).toBe(true);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await handleRetry([last.message], env);
      expect(last.state).toEqual({ acked: true, retried: null });
      expect(stored.has("pending/x")).toBe(false);
      log.mockRestore();
    }
  });

  it("acknowledges a retry whose message is already gone", async () => {
    const calls = provider({ result: "accept" }), { env, body } = await held();
    await env.PENDING.delete("pending/x");
    const { message, state } = retryMessage(body, 2);
    await handleRetry([message], env);
    expect(state.acked).toBe(true);
    expect(calls).toEqual([]);
  });
});
