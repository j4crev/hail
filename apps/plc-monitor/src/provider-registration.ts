import { isDeepStrictEqual } from "node:util";
import { randomInt } from "node:crypto";
import { decodeBase64Url } from "@racrproto/codec/base64url";
import type { EnrollmentProviders } from "./providers.js";
import { ProviderAdmissionError, retireProvider } from "./providers.js";
import { boundedBody, hash } from "./http.js";
import type { MonitorSigner } from "./signing.js";
import { PinnedHttpsClient } from "./public-http.js";
import { emailAddress, httpsOrigin } from "./receiver-provider-wire.js";
import type { ReceiverClient } from "./receiver-provisioning.js";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";

// Registration v2 (spec/monitor-receiver.md). v1 was removed under the pre-launch policy.
export const REGISTRATION_PATH = "/.well-known/hail-monitor-registration";
const CODE_LIFETIME_SECONDS = 600, RESEND_COOLDOWN_SECONDS = 60, MAX_CODE_ATTEMPTS = 5;

export interface RegistrationInput {
  monitorApiOrigin: string; providerOrigin: string; webOrigin?: string;
  registrationSecret: string; expiresAt: number;
}

export async function registrationDocument(input: RegistrationInput) {
  for (const origin of [input.monitorApiOrigin, input.providerOrigin, ...(input.webOrigin ? [input.webOrigin] : [])])
    if (!httpsOrigin(origin)) throw new Error("Registration uses canonical HTTPS origins on port 443");
  if (input.webOrigin === input.providerOrigin) throw new Error("The web origin must differ from the provider origin");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.registrationSecret) || !Number.isSafeInteger(input.expiresAt))
    throw new Error("Invalid registration secret or expiry");
  decodeBase64Url(input.registrationSecret, 32);
  return { type: "hail.monitor-provider-registration", version: 2, monitorApiOrigin: input.monitorApiOrigin,
    providerOrigin: input.providerOrigin, ...(input.webOrigin ? { webOrigin: input.webOrigin } : {}),
    registrationHash: await hash(input.registrationSecret), expiresAt: input.expiresAt };
}

type Receiver = Pick<ReceiverClient, "origin" | "provision" | "verifyOperator">;
interface PendingCode {
  provider_origin: string; web_origin: string | null; operator_email: string; code_hash: string;
  attempts: number; sent_at: Date; expires_at: Date;
}

export function createProviderRegistrationApi(providers: EnrollmentProviders, signer: MonitorSigner, monitorOrigin: string,
  receiver: Receiver | undefined, get: (url: string) => Promise<Response> = url => new PinnedHttpsClient().get(url), apiOrigin = monitorOrigin) {
  // Bounded per-process admission before DNS or database work, even for malformed input.
  let window = 0, requests = 0, active = 0;
  const json = (value: unknown, status: number, retry?: number) => Response.json(value, { status,
    headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": String(retry ?? 60) } : {}) } });
  const codeHash = (registrationHash: string, code: string) => hash(`${registrationHash}\0${code}`);
  return { async fetch(request: Request) {
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (Date.now() - window >= 60_000) { window = Date.now(); requests = 0; }
    if (++requests > 20 || active >= 2) return json({ error: "Registration busy; retry later" }, 429);
    if (request.headers.get("content-type") !== "application/json" || request.headers.has("content-encoding"))
      return json({ error: "Use uncoded JSON" }, 415);
    if (!receiver) return json({ error: "Registration requires the shared receiver; contact the monitor operator" }, 503);
    active++;
    try {
      const bytes = await boundedBody(request, 4096);
      if (!bytes) return json({ error: "Registration exceeds limit" }, 413);
      let doc: Awaited<ReturnType<typeof registrationDocument>>, operatorEmail: string, operatorCode: string | undefined, resend: boolean;
      try {
        const input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
        const allowed = ["providerOrigin", "webOrigin", "operatorEmail", "registrationSecret", "expiresAt", "operatorCode", "resend"];
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
          typeof input.providerOrigin !== "string" || input.webOrigin !== undefined && typeof input.webOrigin !== "string" ||
          typeof input.registrationSecret !== "string" || typeof input.expiresAt !== "number" ||
          input.operatorCode !== undefined && (typeof input.operatorCode !== "string" || !/^\d{8}$/.test(input.operatorCode)) ||
          input.resend !== undefined && typeof input.resend !== "boolean" || input.operatorCode !== undefined && input.resend) throw Error();
        const email = emailAddress(input.operatorEmail);
        if (!email) throw Error();
        operatorEmail = email; operatorCode = input.operatorCode as string | undefined; resend = input.resend === true;
        doc = await registrationDocument({ monitorApiOrigin: apiOrigin, providerOrigin: input.providerOrigin,
          ...(input.webOrigin ? { webOrigin: input.webOrigin as string } : {}),
          registrationSecret: input.registrationSecret, expiresAt: input.expiresAt });
        const now = Math.floor(Date.now() / 1000);
        if (doc.expiresAt <= now || doc.expiresAt > now + 3600) throw Error();
      } catch { return json({ error: "Invalid registration; use a fresh verification document and a valid operator email" }, 400); }
      // Every declared origin must opt in to this exact monitor and provider. The
      // document contains only a hash, never the registration secret.
      for (const origin of [doc.providerOrigin, ...(doc.webOrigin ? [doc.webOrigin] : [])]) {
        try {
          const response = await get(origin + REGISTRATION_PATH);
          if (response.status !== 200) { await response.body?.cancel(); throw Error(); }
          const body = await boundedBody(response, 4096);
          if (!body || !isDeepStrictEqual(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(body)), doc)) throw Error();
        } catch { return json({ error: "Publish the exact verification document on every declared origin" }, 409); }
      }
      const webOrigin = doc.webOrigin ?? null;
      const derivation = new TextEncoder().encode(JSON.stringify([apiOrigin, doc.providerOrigin, receiver.origin, webOrigin, doc.registrationHash]));
      const token = signer.registrationToken(derivation), receiverToken = signer.receiverToken(derivation);
      const result = await providers.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(686169156)`;
        if (doc.expiresAt <= Math.floor(Date.now() / 1000))
          throw new ProviderAdmissionError(409, "Verification document expired; publish a fresh document");
        let row = (await tx`SELECT * FROM monitor_enrollment_providers
          WHERE provider_origin=${doc.providerOrigin} AND retired_at IS NULL FOR UPDATE`)[0];
        // A different registration for an active origin replaces it (lost credentials or
        // a rebuilt server). Proving the origins is not enough: whoever controls the server
        // could otherwise switch off monitoring of its users, so the code goes only to the
        // operator email already on file.
        const replacing = row && row.registration_hash !== doc.registrationHash ? row : undefined;
        if (row && !replacing) {
          // An exact retry of a completed registration returns the same credentials.
          if (!row.enabled || row.web_origin !== webOrigin ||
            row.token_hash !== await hash(token) || row.receiver_token_hash !== await hash(receiverToken))
            throw new ProviderAdmissionError(409, "Provider already registered; use its credentials or contact the operator");
          return { row };
        }
        if (replacing && !replacing.enabled)
          throw new ProviderAdmissionError(409, "This provider's registration is disabled; contact the monitor operator");
        if (replacing && replacing.operator_email?.toLowerCase() !== operatorEmail.toLowerCase())
          throw new ProviderAdmissionError(409, "This provider is already registered; to replace the registration, use its registered operator email");
        const pending = (await tx<PendingCode[]>`SELECT * FROM monitor_provider_registration_codes
          WHERE registration_hash=${doc.registrationHash} FOR UPDATE`)[0];
        if (pending && (pending.provider_origin !== doc.providerOrigin || pending.web_origin !== webOrigin || pending.operator_email !== operatorEmail))
          throw new ProviderAdmissionError(409, "This registration secret belongs to a different request");
        const live = pending && pending.expires_at.getTime() > Date.now();
        if (!operatorCode) {
          if (live && !resend) return { sent: pending.expires_at };
          if (live && Date.now() - pending.sent_at.getTime() < RESEND_COOLDOWN_SECONDS * 1000)
            throw new ProviderAdmissionError(429, "Wait before requesting another code");
          const code = String(randomInt(0, 100_000_000)).padStart(8, "0"), expiresAt = new Date(Date.now() + CODE_LIFETIME_SECONDS * 1000);
          await tx`INSERT INTO monitor_provider_registration_codes(registration_hash,provider_origin,web_origin,operator_email,code_hash,expires_at)
            VALUES (${doc.registrationHash},${doc.providerOrigin},${webOrigin},${operatorEmail},${await codeHash(doc.registrationHash, code)},${expiresAt})
            ON CONFLICT (registration_hash) DO UPDATE SET code_hash=excluded.code_hash,attempts=0,sent_at=clock_timestamp(),expires_at=excluded.expires_at`;
          return { send: { code, expiresAt } };
        }
        if (!live || pending.attempts >= MAX_CODE_ATTEMPTS)
          throw new ProviderAdmissionError(409, "The code expired or ran out of attempts; request a new code");
        if (pending.code_hash !== await codeHash(doc.registrationHash, operatorCode)) {
          await tx`UPDATE monitor_provider_registration_codes SET attempts=attempts+1 WHERE registration_hash=${doc.registrationHash}`;
          return { wrongCode: true };
        }
        if (!replacing && (await tx`SELECT count(*)::integer AS count FROM monitor_enrollment_providers
          WHERE retired_at IS NULL`)[0]!.count >= 100)
          throw new ProviderAdmissionError(429, "Provider capacity reached");
        if (replacing) await retireProvider(tx, replacing.id);
        row = (await tx`INSERT INTO monitor_enrollment_providers(id,provider_origin,alert_origin,web_origin,operator_email,
            token_hash,receiver_token_hash,registration_hash)
          VALUES (${crypto.randomUUID()},${doc.providerOrigin},${receiver.origin},${webOrigin},${operatorEmail},
            ${await hash(token)},${await hash(receiverToken)},${doc.registrationHash}) RETURNING *`)[0]!;
        await tx`DELETE FROM monitor_provider_registration_codes WHERE registration_hash=${doc.registrationHash}`;
        return { row };
      });
      if ("wrongCode" in result) return json({ error: "Incorrect code" }, 409);
      if ("sent" in result) return json({ verification: "email-sent", expiresAt: Math.floor(result.sent!.getTime() / 1000) }, 202);
      if ("send" in result) {
        try { await receiver.verifyOperator(operatorEmail, result.send!.code, doc.providerOrigin, Math.floor(result.send!.expiresAt.getTime() / 1000)); }
        catch {
          await providers.sql`DELETE FROM monitor_provider_registration_codes WHERE registration_hash=${doc.registrationHash} AND sent_at>now()-interval '1 minute'`;
          return json({ error: "Could not send the operator code; retry later" }, 503);
        }
        return json({ verification: "email-sent", expiresAt: Math.floor(result.send!.expiresAt.getTime() / 1000) }, 202);
      }
      const row = result.row!;
      // A replaced registration's receiver credential stops working before the new one is issued.
      await providers.syncRetiredReceivers(row.provider_origin, record => receiver.provision(record));
      if (!row.receiver_provisioned_at) {
        // Provisioning is retried by an exact retry of the completed request.
        await receiver.provision({ providerId: row.id, providerOrigin: row.provider_origin, webOrigin: row.web_origin,
          tokenHash: row.receiver_token_hash, enabled: true });
        await providers.sql`UPDATE monitor_enrollment_providers SET receiver_provisioned_at=clock_timestamp() WHERE id=${row.id}`;
      }
      return json({ providerId: row.id, providerOrigin: row.provider_origin, webOrigin: row.web_origin,
        token, receiverOrigin: receiver.origin, receiverToken, monitorOrigin, apiOrigin, monitorPublicKey: signer.publicDidKey,
        limits: { requestsPerMinute: row.requests_per_minute, activeIdentities: row.max_identities, enrollmentsPerDay: row.enrollments_per_day } }, 200);
    } catch (error) {
      return json({ error: error instanceof ProviderAdmissionError ? error.message : "Registration temporarily unavailable" },
        error instanceof ProviderAdmissionError ? error.status : 503);
    } finally { active--; }
  } };
}

/**
 * `POST /api/v1/providers/deregister`: a provider leaves the monitor with its own monitor
 * credential (spec/monitor-receiver.md). Monitoring of every identity it enrolled stops,
 * both credentials stop working, and its origin may register again. Retries are safe.
 */
export function createProviderDeregistrationApi(providers: EnrollmentProviders, receiver: Pick<ReceiverClient, "provision"> | undefined) {
  const json = (value: unknown, status: number) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return { async fetch(request: Request) {
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (request.headers.get("content-type") !== "application/json" || request.headers.has("content-encoding"))
      return json({ error: "Use uncoded JSON" }, 415);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) return json({ error: "Unauthorized" }, 401);
    let providerOrigin: string;
    try {
      const bytes = await boundedBody(request, 1024);
      if (!bytes) return json({ error: "Deregistration exceeds limit" }, 413);
      const input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join(",") !== "providerOrigin" ||
        !httpsOrigin(input.providerOrigin)) throw Error();
      providerOrigin = input.providerOrigin;
    } catch { return json({ error: "Send exactly the provider origin" }, 400); }
    let result: { id: string; stopped: number };
    try { result = await providers.deregister(token, providerOrigin); }
    catch (error) {
      return json({ error: error instanceof ProviderAdmissionError ? error.message : "Deregistration temporarily unavailable" },
        error instanceof ProviderAdmissionError ? error.status : 503);
    }
    if (receiver) {
      try { await providers.syncRetiredReceivers(providerOrigin, record => receiver.provision(record)); }
      catch { return json({ error: "Deregistered, but the receiver was not updated yet; retry" }, 503); }
    }
    return json({ providerId: result.id, providerOrigin, deregistered: true, stoppedIdentities: result.stopped }, 200);
  } };
}
