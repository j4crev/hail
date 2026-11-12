import { decodeBase64Url } from "@racrproto/codec/base64url";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { hash } from "../../src/http.js";
import { emailAddress, type OperatorVerification, type ReceiverProviderRecord } from "../../src/receiver-provider-wire.js";

export interface EmailBinding {
  send(message: { to: string; from: { email: string; name: string }; subject: string; text: string; html?: string }): Promise<{ messageId: string }>;
}
export interface EmailEnvironment {
  EMAIL: EmailBinding; SIGNUP_SENDER: string;
  /** Temporary migration: recipients bound before registration v2 belong to this provider origin. */
  LEGACY_RECIPIENT_PROVIDER_ORIGIN?: string;
}
export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  transaction<T>(callback: (transaction: Pick<DurableStorage, "get" | "put" | "delete">) => Promise<T>): Promise<T>;
}
/** A provider registered at the shared monitor (spec/monitor-receiver.md). */
export type Provider = Omit<ReceiverProviderRecord, "type" | "version">;
interface Signup {
  email: string; signupHash: string; codeHash: string | null; attempts: number;
  state: "sending" | "pending" | "verified" | "bound";
  expiresAt: number; lastSendAt: number; claim: string; verifiedAt?: number;
  did?: string; operationCid?: string;
}
export interface Recipient {
  monitorControlled?: boolean; providerId?: string;
  hailAddress?: string; email: string; signupId: string; signupHash: string; did: string; operationCid: string; verifiedAt: number;
}
interface Rate { count: number; expiresAt: number; }
const hour = 3_600_000, codeLifetime = 10 * 60_000, verifiedLifetime = 24 * hour;
const MAILBOX_LIMIT = 5, PROVIDER_LIMIT = 100, GLOBAL_LIMIT = 1000;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const signupEmailPaths = new Set(["/signup-email", "/signup-email/verify", "/signup-email/bind", "/signup-email/invite", "/signup-email/remove-monitoring"]);
const reply = (value: unknown, status = 200, retry?: number) => Response.json(value, { status,
  headers: { "Cache-Control": "no-store", ...(retry ? { "Retry-After": String(retry) } : {}) } });

/** Pre-v2 signups were not namespaced; they expire within 24 hours of creation. */
export const signupKey = (providerId: string | undefined, signupId: string) => providerId ? `signup:${providerId}:${signupId}` : `signup:${signupId}`;
const publicOrigin = (provider: Provider) => provider.webOrigin ?? provider.providerOrigin;

function code(): string {
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (value >= 4_200_000_000);
  return String(value % 100_000_000).padStart(8, "0");
}

export async function sendEmail(env: Pick<EmailEnvironment, "EMAIL">, message: Omit<Parameters<EmailBinding["send"]>[0], "from"> & { from: string }): Promise<void> {
  try { await env.EMAIL.send({ ...message, from: { email: message.from, name: "Hail" } }); }
  catch { throw new Error("Email delivery unavailable"); } // Do not expose vendor errors containing recipients or message content.
}

/** Takes one send from each bucket, or reports the earliest retry when any is exhausted. */
async function takeRate(tx: Pick<DurableStorage, "get" | "put">, buckets: [string, number][], now: number): Promise<number | null> {
  const current = await Promise.all(buckets.map(async ([key, limit]) => [key, limit, await tx.get<Rate>(key)] as const));
  const full = current.filter(([, limit, rate]) => rate && rate.expiresAt > now && rate.count >= limit);
  if (full.length) return Math.max(1, Math.ceil((Math.min(...full.map(([, , rate]) => rate!.expiresAt)) - now) / 1000));
  for (const [key, , rate] of current)
    await tx.put(key, rate && rate.expiresAt > now ? { ...rate, count: rate.count + 1 } : { count: 1, expiresAt: now + hour });
  return null;
}

/**
 * DID and CID of a signed PLC genesis, computed without trusting the caller:
 * the DID is the first 24 base32 characters of SHA-256 over its DAG-CBOR bytes.
 */
export async function genesisIdentity(operation: unknown): Promise<{ did: string; operationCid: string; endpoint: unknown }> {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw Error("Invalid genesis");
  const op = operation as Record<string, unknown>;
  if (op.type !== "plc_operation" || op.prev !== null || typeof op.sig !== "string") throw Error("Invalid genesis");
  const bytes = Uint8Array.from(encodeDagCbor(op)), digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const services = op.services as Record<string, { endpoint?: unknown }> | undefined;
  return { did: `did:plc:${base32.baseEncode(digest).slice(0, 24)}`,
    operationCid: CID.createV1(0x71, Digest.create(0x12, digest)).toString(), endpoint: services?.hail?.endpoint };
}

export async function providerForToken(storage: Pick<DurableStorage, "get">, tokenHash: string): Promise<Provider | undefined> {
  const id = await storage.get<string>(`provider-token:${tokenHash}`);
  const provider = id ? await storage.get<Provider>(`provider:${id}`) : undefined;
  return provider?.enabled && provider.tokenHash === tokenHash ? provider : undefined;
}

/** Applies a monitor-signed provider record; an older record never overwrites a newer one. */
export async function provisionProvider(record: ReceiverProviderRecord, storage: DurableStorage, env: EmailEnvironment): Promise<Response> {
  const { type: _type, version: _version, ...provider } = record;
  const result = await storage.transaction(async tx => {
    const prior = await tx.get<Provider>(`provider:${provider.providerId}`);
    if (prior && prior.issuedAt > provider.issuedAt) return 204;
    if (prior && prior.providerOrigin !== provider.providerOrigin) return 409;
    const owner = await tx.get<string>(`provider-token:${provider.tokenHash}`);
    if (owner && owner !== provider.providerId) return 409;
    if (prior && prior.tokenHash !== provider.tokenHash) await tx.delete(`provider-token:${prior.tokenHash}`);
    await tx.put(`provider:${provider.providerId}`, provider);
    await tx.put(`provider-token:${provider.tokenHash}`, provider.providerId);
    return 204;
  });
  if (result === 204 && provider.providerOrigin === env.LEGACY_RECIPIENT_PROVIDER_ORIGIN) {
    for (const [key, recipient] of await storage.list<Recipient>({ prefix: "recipient:" })) {
      if (recipient.providerId) continue;
      await storage.transaction(async tx => {
        const current = await tx.get<Recipient>(key);
        if (current && !current.providerId) await tx.put(key, { ...current, providerId: provider.providerId });
      });
    }
  }
  return new Response(null, { status: result, headers: { "Cache-Control": "no-store" } });
}

/** Sends the fixed operator-verification template once per distinct signed request. */
export async function sendOperatorVerification(request: OperatorVerification, storage: DurableStorage, env: EmailEnvironment): Promise<Response> {
  const now = Date.now(), key = `operator-code:${await hash(JSON.stringify([request.email, request.code, request.providerOrigin, request.expiresAt]))}`;
  const claimed = await storage.transaction(async tx => {
    const prior = await tx.get<{ state: string; expiresAt: number }>(key);
    if (prior) return prior.state === "sent" ? "sent" : "busy";
    if (await takeRate(tx, [[`email-rate:operator:${await hash(request.email)}`, MAILBOX_LIMIT], ["email-rate:global", GLOBAL_LIMIT]], now) !== null)
      return "limited";
    await tx.put(key, { state: "sending", expiresAt: request.expiresAt * 1000 });
    return "send";
  });
  if (!(await storage.getAlarm())) await storage.setAlarm(now + hour);
  if (claimed !== "send") return new Response(null, { status: claimed === "sent" ? 204 : claimed === "busy" ? 503 : 429 });
  try {
    await sendEmail(env, { to: request.email, from: env.SIGNUP_SENDER, subject: "Verify your Hail provider registration",
      text: `Your Hail provider registration code is: ${request.code}\n\nEnter it to finish registering this provider with the shared Hail monitor:\n${request.providerOrigin}\n\nIt expires at ${new Date(request.expiresAt * 1000).toISOString()}.\n\nThis address will receive operator notices about this provider, such as credential rotation and quota changes. It is not shown to users.\n\nIf you did not start this registration, ignore this email.` });
    await storage.put(key, { state: "sent", expiresAt: request.expiresAt * 1000 });
    return new Response(null, { status: 204 });
  } catch {
    await storage.delete(key);
    return new Response(null, { status: 503 });
  }
}

export async function signupEmail(path: string, input: unknown, storage: DurableStorage, env: EmailEnvironment, provider: Provider): Promise<Response> {
  if (path === "/signup-email/remove-monitoring") return removeMonitoring(input, storage, provider);
  if (path === "/signup-email/invite") return sendSignupInvitation(input, storage, env, provider);
  if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "Invalid signup email request" }, 400);
  const row = input as Record<string, unknown>, fields = path === "/signup-email" ? ["signupId", "signupHash", "email", "resend"] :
    path === "/signup-email/verify" ? ["signupId", "signupHash", "code"] : ["signupId", "signupHash", "did", "operationCid", "hailAddress", "operation"];
  if (Object.keys(row).some(key => !fields.includes(key)) || typeof row.signupId !== "string" || !uuid.test(row.signupId) ||
    typeof row.signupHash !== "string") return reply({ error: "Invalid signup email request" }, 400);
  try { decodeBase64Url(row.signupHash, 32); } catch { return reply({ error: "Invalid signup email request" }, 400); }
  const signupId = row.signupId, signupHash = row.signupHash, key = signupKey(provider.providerId, signupId), now = Date.now();

  if (path === "/signup-email") {
    const email = emailAddress(row.email);
    if (!email || row.resend !== undefined && typeof row.resend !== "boolean") return reply({ error: "Invalid email address" }, 400);
    const origin = new URL(publicOrigin(provider));
    const challenge = code(), codeHash = await hash(`${signupId}\0${signupHash}\0${email}\0${challenge}`), claim = crypto.randomUUID();
    const mailboxKey = `email-rate:${await hash(email.toLowerCase())}`;
    const result = await storage.transaction(async tx => {
      const prior = await tx.get<Signup>(key);
      if (prior && (prior.email !== email || prior.signupHash !== signupHash)) return { status: 409 };
      if (prior?.state === "bound" || prior?.state === "verified" && prior.expiresAt > now) return { verified: true, expiresAt: prior.expiresAt };
      if (prior?.state === "pending" && prior.expiresAt > now && !row.resend) return { verified: false, expiresAt: prior.expiresAt };
      if (prior && now - prior.lastSendAt < 60_000) return { status: prior.state === "sending" ? 503 : 429, retry: 60 };
      const retry = await takeRate(tx, [[mailboxKey, MAILBOX_LIMIT], [`email-rate:provider:${provider.providerId}`, PROVIDER_LIMIT],
        ["email-rate:global", GLOBAL_LIMIT]], now);
      if (retry !== null) return { status: 429, retry };
      await tx.put(key, { email, signupHash, codeHash, claim, state: "sending", attempts: 0,
        expiresAt: now + codeLifetime, lastSendAt: now } satisfies Signup);
      return { send: true, expiresAt: now + codeLifetime };
    });
    if (!(await storage.getAlarm())) await storage.setAlarm(now + hour);
    if (result.status) return reply({ error: "Signup email request refused" }, result.status, result.retry);
    if (!result.send) return reply({ verified: result.verified, expiresAt: result.expiresAt });
    try {
      await sendEmail(env, { to: email, from: env.SIGNUP_SENDER, subject: "Verify your Hail security email",
        text: `Your Hail signup verification code is: ${challenge}\n\nEnter it only in the signup you started at:\n${origin.href}\n\nIt expires in 10 minutes.\n\nThis verifies where identity-security alerts should be sent. It does not sign you in, reset your account or authorize recovery. Never send anyone your recovery secret.\n\nIf you did not request this email, ignore it.` });
      return await storage.transaction(async tx => {
        const saved = await tx.get<Signup>(key);
        if (!saved || saved.claim !== claim) return reply({ error: "Signup email request superseded" }, 409);
        if (saved.state === "sending") await tx.put(key, { ...saved, state: "pending" });
        return reply({ verified: saved.state === "verified" || saved.state === "bound", expiresAt: saved.expiresAt });
      });
    } catch { return reply({ error: "Signup email delivery unavailable; retry later" }, 503, 60); }
  }

  if (path === "/signup-email/verify") {
    if (typeof row.code !== "string" || !/^\d{8}$/.test(row.code)) return reply({ error: "Invalid verification code" }, 400);
    const supplied = row.code;
    return storage.transaction(async tx => {
      const saved = await tx.get<Signup>(key);
      if (!saved || saved.signupHash !== signupHash || saved.state !== "bound" && saved.expiresAt <= now)
        return reply({ error: "Verification refused or expired" }, 409);
      if (saved.state === "verified" || saved.state === "bound") return reply({ verified: true, expiresAt: saved.expiresAt });
      if (saved.attempts >= 5) return reply({ error: "Verification attempts exhausted; request a new code" }, 429);
      const correct = saved.codeHash === await hash(`${signupId}\0${signupHash}\0${saved.email}\0${supplied}`);
      await tx.put(key, { ...saved, attempts: saved.attempts + 1, ...(correct ? {
        state: "verified", codeHash: null, verifiedAt: now, expiresAt: now + verifiedLifetime,
      } : {}) });
      return correct ? reply({ verified: true, expiresAt: now + verifiedLifetime }) : reply({ error: "Verification refused or expired" }, 409);
    });
  }

  if (typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) || typeof row.operationCid !== "string")
    return reply({ error: "Invalid signup identity" }, 400);
  // The DID must belong to this provider: its exact genesis names the provider's
  // Hail service, so no provider can bind (and so block) another provider's DID.
  try {
    const genesis = await genesisIdentity(row.operation);
    if (genesis.did !== row.did || genesis.operationCid !== row.operationCid || genesis.endpoint !== `${provider.providerOrigin}/hail`) throw Error();
  } catch { return reply({ error: "Signup identity does not belong to this provider" }, 400); }
  // Optional for old senders; never infer the Hail address from the security email.
  if (row.hailAddress !== undefined && (typeof row.hailAddress !== "string" || row.hailAddress.length > 254 ||
    !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(row.hailAddress)))
    return reply({ error: "Invalid Hail address" }, 400);
  const hailAddress = row.hailAddress as string | undefined;
  const did = row.did, operationCid = row.operationCid;
  return storage.transaction(async tx => {
    const saved = await tx.get<Signup>(key), recipientKey = `recipient:${did}`, recipient = await tx.get<Recipient>(recipientKey);
    if (await tx.get(`stopped-monitoring:${did}`) || await tx.get(`stopped-by:${provider.providerId}:${did}`))
      return reply({ error: "Monitoring was stopped" }, 409);
    if (!saved || saved.signupHash !== signupHash || !saved.verifiedAt ||
      saved.state !== "verified" && saved.state !== "bound" || saved.state !== "bound" && saved.expiresAt <= now ||
      saved.state === "bound" && (saved.did !== did || saved.operationCid !== operationCid) ||
      recipient && (recipient.providerId !== undefined && recipient.providerId !== provider.providerId ||
        recipient.signupId !== signupId || recipient.signupHash !== signupHash || recipient.operationCid !== operationCid || recipient.email !== saved.email ||
        hailAddress !== undefined && recipient.hailAddress !== undefined && recipient.hailAddress !== hailAddress))
      return reply({ error: "Verified signup destination cannot be bound" }, 409);
    const retainedAddress = recipient?.hailAddress ?? hailAddress;
    await tx.put(recipientKey, { ...(recipient?.monitorControlled ? { monitorControlled: true } : {}), providerId: provider.providerId,
      ...(retainedAddress ? { hailAddress: retainedAddress } : {}), email: saved.email, signupId, signupHash, did, operationCid,
      verifiedAt: saved.verifiedAt } satisfies Recipient);
    await tx.put(key, { ...saved, state: "bound", codeHash: null, did, operationCid });
    return reply({ bound: true, did, operationCid });
  });
}

export async function pruneSignupEmail(storage: DurableStorage): Promise<void> {
  const now = Date.now();
  let pending = false;
  // ponytail: one existing coordination object, partition by signup/DID if alpha volume makes these scans expensive.
  for (const prefix of ["signup:", "email-rate:", "invitation:", "operator-code:"])
    for (const [key, value] of await storage.list<{ expiresAt: number; state?: string }>({ prefix })) {
      if (value.state === "bound") continue;
      if (value.expiresAt <= now) await storage.transaction(async tx => {
        const current = await tx.get<{ expiresAt: number; state?: string }>(key);
        if (current && current.state !== "bound" && current.expiresAt <= now) await tx.delete(key);
        else if (current && current.state !== "bound") pending = true;
      });
      else pending = true;
    }
  if (pending) await storage.setAlarm(now + hour);
}

// The provider supplies a signed bearer, while this service pins the destination
// origin and message template. It cannot be used to send arbitrary email content.
async function sendSignupInvitation(input: unknown, storage: DurableStorage, env: EmailEnvironment, provider: Provider): Promise<Response> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "Invalid invitation" }, 400);
  const row = input as Record<string, unknown>, email = emailAddress(row.email), now = Date.now();
  if (Object.keys(row).sort().join(",") !== "email,expiresAt,id,url" || typeof row.id !== "string" || !uuid.test(row.id) || !email ||
    typeof row.url !== "string" || row.url.length > 3000 || typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt * 1000 <= now || row.expiresAt * 1000 > now + 7 * 86400_000 + 300_000) return reply({ error: "Invalid invitation" }, 400);
  let url: URL;
  try {
    url = new URL(row.url);
    if (url.protocol !== "https:" || url.origin !== publicOrigin(provider) || url.pathname !== "/signup" || url.search || url.username || url.password ||
      !/^#invitation=[A-Za-z0-9_.%-]+$/.test(url.hash)) throw new Error();
  } catch { return reply({ error: "Invalid invitation URL" }, 400); }
  const digest = await hash(JSON.stringify({ email, url: row.url, expiresAt: row.expiresAt })), key = `invitation:${provider.providerId}:${row.id}`;
  type InvitationRecord = { digest: string; state: "sending" | "sent"; expiresAt: number };
  const result = await storage.transaction(async tx => {
    const prior = await tx.get<InvitationRecord>(key);
    if (prior) return prior.digest !== digest ? 409 : prior.state === "sent" ? 204 : 503;
    if (await takeRate(tx, [[`email-rate:invite:${await hash(email.toLowerCase())}`, MAILBOX_LIMIT],
      [`email-rate:invite-provider:${provider.providerId}`, PROVIDER_LIMIT], ["email-rate:invite-global", GLOBAL_LIMIT]], now) !== null) return 429;
    await tx.put(key, { digest, state: "sending", expiresAt: (row.expiresAt as number) * 1000 } satisfies InvitationRecord);
    return 0;
  });
  if (!(await storage.getAlarm())) await storage.setAlarm(now + hour);
  if (result) return new Response(null, { status: result, headers: { "Cache-Control": "no-store" } });
  try {
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
    await sendEmail(env, { to: email, from: env.SIGNUP_SENDER, subject: "You're invited to Hail",
      html: `<p>You've been invited to create an account at ${escapeHtml(url.origin)}.</p><p><a href="${escapeHtml(url.href)}">Join Now</a></p><p>This single-use invitation expires ${new Date(row.expiresAt * 1000).toISOString()}. Keep the link private. It allows signup only, not access to an existing account.</p><p>If you weren't expecting this invitation, you can ignore it.</p>`,
      text: `You've been invited to create an account at ${url.origin}.\n\n${url.href}\n\nThis single-use invitation expires ${new Date(row.expiresAt * 1000).toISOString()}. Keep the link private. It allows signup only, not access to an existing account.\n\nIf you weren't expecting this invitation, you can ignore it.` });
    await storage.put(key, { digest, state: "sent", expiresAt: row.expiresAt * 1000 } satisfies InvitationRecord);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    // An email API failure can be ambiguous. Do not send a second copy on retry.
    return reply({ error: "Invitation delivery unconfirmed" }, 503);
  }
}

// Provider-authenticated, reduced-assurance signup receiver only. Keep a minimal
// DID/CID tombstone; erase the recipient and its retained signup email record.
async function removeMonitoring(input: unknown, storage: DurableStorage, provider: Provider): Promise<Response> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return reply({ error: "Invalid removal" }, 400);
  const row = input as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "did,operationCid" || typeof row.did !== "string" ||
    !/^did:plc:[a-z2-7]{24}$/.test(row.did) || typeof row.operationCid !== "string") return reply({ error: "Invalid removal" }, 400);
  try {
    const cid = CID.parse(row.operationCid);
    if (cid.toString() !== row.operationCid || cid.code !== 0x71 || cid.multihash.code !== 0x12 || cid.multihash.digest.length !== 32) throw new Error();
  } catch { return reply({ error: "Invalid removal" }, 400); }
  const did = row.did, operationCid = row.operationCid;
  return storage.transaction(async tx => {
    const recipient = await tx.get<Recipient>(`recipient:${did}`), stopped = await tx.get<string>(`stopped-monitoring:${did}`);
    if (recipient?.monitorControlled) return reply({ error: "Monitor authorization required" }, 409);
    if (recipient && recipient.operationCid !== operationCid || stopped && stopped !== operationCid)
      return reply({ error: "Enrollment differs" }, 409);
    const done = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    if (recipient) {
      // Only the provider that bound a DID can stop its monitoring.
      if (recipient.providerId !== provider.providerId) return reply({ error: "Enrollment differs" }, 409);
      await tx.put(`stopped-monitoring:${did}`, operationCid);
      await tx.delete(`recipient:${did}`);
      await tx.delete(signupKey(recipient.providerId, recipient.signupId));
    } else if (!stopped) {
      // Without a binding there is no proven owner, so the tombstone blocks only this provider's later bind.
      await tx.put(`stopped-by:${provider.providerId}:${did}`, operationCid);
    }
    return done;
  });
}
