import { isDeepStrictEqual } from "node:util";
import { decodeBase64Url } from "@racrproto/codec/base64url";
import type { EnrollmentProviders } from "./providers.js";
import { canonicalOrigin, ProviderAdmissionError } from "./providers.js";
import { boundedBody, hash } from "./http.js";
import type { MonitorSigner } from "./signing.js";
import { PinnedHttpsClient } from "./public-http.js";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";

export const REGISTRATION_PATH = "/.well-known/hail-monitor-registration";
export async function registrationDocument(input: {
  monitorApiOrigin: string; providerOrigin: string; alertOrigin: string; registrationSecret: string; expiresAt: number;
}) {
  for (const origin of [input.monitorApiOrigin, input.providerOrigin, input.alertOrigin]) {
    canonicalOrigin(origin);
    if (new URL(origin).port) throw new Error("Self-service registration uses HTTPS port 443");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.registrationSecret) || !Number.isSafeInteger(input.expiresAt))
    throw new Error("Invalid registration secret or expiry");
  decodeBase64Url(input.registrationSecret, 32);
  return { type: "hail.monitor-provider-registration", version: 1, monitorApiOrigin: input.monitorApiOrigin,
    providerOrigin: input.providerOrigin, alertOrigin: input.alertOrigin,
    registrationHash: await hash(input.registrationSecret), expiresAt: input.expiresAt };
}

export function createProviderRegistrationApi(providers: EnrollmentProviders, signer: MonitorSigner, monitorOrigin: string,
  get: (url: string) => Promise<Response> = url => new PinnedHttpsClient().get(url), apiOrigin = monitorOrigin) {
  // Bounded per-process admission before DNS or database work, even for malformed input.
  let window = 0, requests = 0, active = 0;
  const json = (value: unknown, status: number) => Response.json(value, { status,
    headers: { "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) } });
  return { async fetch(request: Request) {
    if (request.method !== "POST") return json({ error: "Use POST" }, 405);
    if (Date.now() - window >= 60_000) { window = Date.now(); requests = 0; }
    if (++requests > 20 || active >= 2) return json({ error: "Registration busy; retry later" }, 429);
    if (request.headers.get("content-type") !== "application/json" || request.headers.has("content-encoding"))
      return json({ error: "Use uncoded JSON" }, 415);
    active++;
    try {
      const bytes = await boundedBody(request, 4096);
      if (!bytes) return json({ error: "Registration exceeds limit" }, 413);
      let doc: Awaited<ReturnType<typeof registrationDocument>>;
      try {
        const input = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
        if (!input || Object.keys(input).sort().join(",") !== "alertOrigin,expiresAt,providerOrigin,registrationSecret" ||
          typeof input.providerOrigin !== "string" || typeof input.alertOrigin !== "string" ||
          typeof input.registrationSecret !== "string" || typeof input.expiresAt !== "number") throw Error();
        doc = await registrationDocument({ monitorApiOrigin: apiOrigin, providerOrigin: input.providerOrigin, alertOrigin: input.alertOrigin,
          registrationSecret: input.registrationSecret, expiresAt: input.expiresAt });
        const now = Math.floor(Date.now() / 1000);
        if (doc.expiresAt <= now || doc.expiresAt > now + 3600) throw Error();
      } catch { return json({ error: "Invalid registration; use a fresh verification document" }, 400); }
      // Both origins must explicitly opt in to this exact monitor/provider/receiver
      // binding. The document contains only a hash, never the registration secret.
      for (const origin of new Set([doc.providerOrigin, doc.alertOrigin])) {
        try {
          const response = await get(origin + REGISTRATION_PATH);
          if (response.status !== 200) { await response.body?.cancel(); throw Error(); }
          const body = await boundedBody(response, 4096);
          if (!body || !isDeepStrictEqual(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(body)), doc)) throw Error();
        } catch { return json({ error: "Publish the exact verification document on both origins" }, 409); }
      }
      const token = signer.registrationToken(new TextEncoder().encode(JSON.stringify([
        apiOrigin, doc.providerOrigin, doc.alertOrigin, doc.registrationHash,
      ])));
      const result = await providers.sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(686169156)`;
        if (doc.expiresAt <= Math.floor(Date.now() / 1000))
          throw new ProviderAdmissionError(409, "Verification document expired; publish a fresh document");
        let row = (await tx`SELECT * FROM monitor_enrollment_providers WHERE provider_origin=${doc.providerOrigin} FOR UPDATE`)[0];
        if (row) {
          if (!row.enabled || row.registration_hash !== doc.registrationHash || row.alert_origin !== doc.alertOrigin ||
            row.token_hash !== await hash(token)) throw new ProviderAdmissionError(409, "Provider already registered; use its management credential or contact the operator");
        } else {
          if ((await tx`SELECT count(*)::integer AS count FROM monitor_enrollment_providers`)[0]!.count >= 100)
            throw new ProviderAdmissionError(429, "Provider capacity reached");
          row = (await tx`INSERT INTO monitor_enrollment_providers(id,provider_origin,alert_origin,token_hash,registration_hash)
            VALUES (${crypto.randomUUID()},${doc.providerOrigin},${doc.alertOrigin},${await hash(token)},${doc.registrationHash})
            RETURNING *`)[0]!;
        }
        return { providerId: row.id, providerOrigin: row.provider_origin, alertOrigin: row.alert_origin,
          token, monitorOrigin, apiOrigin, monitorPublicKey: signer.publicDidKey,
          limits: { requestsPerMinute: row.requests_per_minute, activeIdentities: row.max_identities, enrollmentsPerDay: row.enrollments_per_day } };
      });
      return json(result, 200);
    } catch (error) {
      return json({ error: error instanceof ProviderAdmissionError ? error.message : "Registration temporarily unavailable" },
        error instanceof ProviderAdmissionError ? error.status : 503);
    } finally { active--; }
  } };
}
