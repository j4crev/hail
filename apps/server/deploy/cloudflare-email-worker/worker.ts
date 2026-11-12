/**
 * Cloudflare ingress adapter for the email bridge (spec/email-bridge.md).
 *
 * Email Routing hands every message for the alias domain to this Worker
 * (an apex catch-all rule). The Worker asks the provider whether the alias may
 * receive mail and submits the unmodified message through the provider-neutral
 * intake contract. Nothing here is specific to the provider's implementation.
 *
 * Cloudflare differences from the contract, and how they are handled:
 * - A Worker cannot return a temporary SMTP failure, only a permanent rejection.
 *   A provider `defer` (a recipient over its limits) is therefore a rejection.
 * - So that a provider restart or outage does not lose mail, a message that
 *   cannot be handed over is kept in R2 and retried from a queue for days. Its
 *   recipient is checked again on each retry, and refused mail is discarded
 *   silently, as the contract requires of an edge that has already accepted it.
 */

export interface PendingObject { arrayBuffer(): Promise<ArrayBuffer> }
export interface Env {
  /** Provider origin serving the intake contract, for example https://svr.haili.app. */
  PROVIDER_ORIGIN: string;
  /** The alias domain whose apex catch-all routes to this Worker, for example haili.email. */
  ALIAS_DOMAIN: string;
  /** Secret: the provider's EMAIL_BRIDGE_INTAKE_TOKEN. */
  INTAKE_TOKEN: string;
  /** Optional, bytes. Defaults to the provider's 10 MiB limit. */
  MAX_MESSAGE_BYTES?: string;
  PENDING: { put(key: string, value: Uint8Array): Promise<unknown>; get(key: string): Promise<PendingObject | null>; delete(key: string): Promise<void> };
  RETRY: { send(body: RetryBody, options?: { delaySeconds?: number }): Promise<void> };
}
export interface IncomingEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}
export interface RetryBody { key: string; recipient: string; envelopeSender: string; receivedAt: number }
export interface RetryMessage { readonly body: RetryBody; readonly attempts: number; ack(): void; retry(options?: { delaySeconds?: number }): void }

type Outcome = "accept" | "reject" | "defer" | "accepted" | "duplicate";
const REFUSED = "No such recipient";
const OVER_LIMIT = "Recipient is not accepting mail right now";
/** Retries at doubling intervals, capped at the 12-hour queue maximum, cover about five days. */
export const MAX_ATTEMPTS = 16;
const retryDelay = (attempts: number) => Math.min(43_200, 60 * 2 ** Math.max(0, attempts - 1));

class Unavailable extends Error {}

async function intake(env: Env, path: "check" | "messages", init: RequestInit, timeoutMs: number): Promise<Outcome> {
  let response: Response;
  try {
    response = await fetch(`${env.PROVIDER_ORIGIN}/email-bridge/v1/intake/${path}`, {
      ...init, method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${env.INTAKE_TOKEN}` },
    });
  } catch { throw new Unavailable("provider unreachable"); }
  // 413 is the contract's answer for an oversized message; anything else unexpected means "try again later".
  if (response.status !== 200 && response.status !== 413) { await response.body?.cancel(); throw new Unavailable(`provider answered ${response.status}`); }
  let result: unknown;
  try { result = ((await response.json()) as { result?: unknown }).result; } catch { throw new Unavailable("unreadable provider answer"); }
  const allowed = path === "check" ? ["accept", "reject", "defer"] : ["accepted", "duplicate", "reject", "defer"];
  if (typeof result !== "string" || !allowed.includes(result)) throw new Unavailable("unexpected provider answer");
  return result as Outcome;
}

const check = (env: Env, recipient: string) =>
  intake(env, "check", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient }) }, 5_000);

const submit = (env: Env, body: RetryBody, raw: Uint8Array) => intake(env, "messages", {
  headers: { "Content-Type": "message/rfc822", "Bridge-Recipient": body.recipient, "Bridge-Received-At": String(body.receivedAt),
    ...(body.envelopeSender && body.envelopeSender.length <= 320 ? { "Bridge-Envelope-Sender": body.envelopeSender } : {}) },
  body: raw as BodyInit,
}, 25_000);

async function readRaw(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Keeps a message the provider could not take yet, and schedules its retry. */
async function hold(env: Env, body: Omit<RetryBody, "key">, raw: Uint8Array): Promise<void> {
  const key = `pending/${crypto.randomUUID()}`;
  await env.PENDING.put(key, raw);
  await env.RETRY.send({ ...body, key }, { delaySeconds: retryDelay(1) });
}

export async function handleEmail(message: IncomingEmail, env: Env): Promise<void> {
  const maxBytes = Number(env.MAX_MESSAGE_BYTES ?? 10 * 1024 * 1024);
  const recipient = message.to.trim().toLowerCase();
  if (!recipient.endsWith(`@${env.ALIAS_DOMAIN}`)) return message.setReject(REFUSED);
  if (message.rawSize > maxBytes) return message.setReject("Message too large");
  const body = { recipient, envelopeSender: message.from, receivedAt: Math.floor(Date.now() / 1000) };

  let decision: Outcome | null;
  try { decision = await check(env, recipient); }
  catch (error) { if (!(error instanceof Unavailable)) throw error; decision = null; }
  if (decision === "reject") return message.setReject(REFUSED);
  if (decision === "defer") return message.setReject(OVER_LIMIT);

  const raw = await readRaw(message.raw, maxBytes);
  if (!raw) return message.setReject("Message too large");
  if (decision === null) return hold(env, body, raw);
  let result: Outcome;
  try { result = await submit(env, { ...body, key: "" }, raw); }
  catch (error) { if (!(error instanceof Unavailable)) throw error; return hold(env, body, raw); }
  if (result === "reject") return message.setReject(REFUSED);
  if (result === "defer") return message.setReject(OVER_LIMIT);
}

export async function handleRetry(messages: readonly RetryMessage[], env: Env): Promise<void> {
  for (const message of messages) {
    const object = await env.PENDING.get(message.body.key);
    if (!object) { message.ack(); continue; }
    let finished: boolean;
    try {
      const result = await submit(env, message.body, new Uint8Array(await object.arrayBuffer()));
      // Accepted, duplicate and refused all end the attempt; refused mail is discarded silently.
      finished = result !== "defer";
    } catch (error) {
      if (!(error instanceof Unavailable)) throw error;
      finished = false;
    }
    if (!finished && message.attempts < MAX_ATTEMPTS) { message.retry({ delaySeconds: retryDelay(message.attempts + 1) }); continue; }
    if (!finished) console.error(JSON.stringify({ level: "error", message: "email bridge gave up on a held message", attempts: message.attempts }));
    await env.PENDING.delete(message.body.key);
    message.ack();
  }
}

export default {
  email: (message: IncomingEmail, env: Env) => handleEmail(message, env),
  queue: (batch: { messages: readonly RetryMessage[] }, env: Env) => handleRetry(batch.messages, env),
};
