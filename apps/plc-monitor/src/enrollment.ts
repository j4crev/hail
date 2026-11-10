import { EnrollmentProviders, ProviderAdmissionError, type EnrollmentProvider } from "./providers.js";
import { PinnedHttpsClient } from "./public-http.js";
import { CID } from "multiformats/cid";
import { cidForCbor } from "@atproto/common";
import { parseDidKey, P256_JWT_ALG, SECP256K1_JWT_ALG } from "@atproto/crypto";
import { assureValidSig, def, didForCreateOp, validateOperationLog } from "@did-plc/lib";
import { encodeBase64Url } from "@racrproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { SIGNUP_ALERT_PATH, SIGNUP_BINDING_PATH, checkEmailBindingQuery, type MonitorEmailBindingQuery } from "./email-binding.js";
import { boundedBody } from "./http.js";
import { assertWebhookUrl, OnboardingMonitorPending, type PlcMonitor } from "./monitor.js";
import type { MonitorSigner } from "./signing.js";
import { parseJsonWithoutDuplicateKeys } from "./strict-json.js";

export interface MonitorEnrollmentConfig {
  monitorOrigin: string; apiOrigin?: string;
  hostname: string; port: number;
}
function origin(value: string | undefined): string {
  if (!value || assertWebhookUrl(value).origin !== value) throw new Error("Enrollment requires canonical HTTPS origins");
  return value;
}

export function monitorEnrollmentConfig(env: Record<string, string | undefined>): MonitorEnrollmentConfig | undefined {
  if (["MONITOR_ENROLLMENT_TOKEN", "MONITOR_ENROLLMENT_PROVIDER", "MONITOR_ENROLLMENT_ALERT_ORIGIN"].some(name => env[name]))
    throw new Error("Import the legacy enrollment provider with monitor:providers before removing legacy settings");
  if (!env.MONITOR_API_HOST && !env.MONITOR_API_PORT) return undefined;
  if (env.PLC_DIRECTORY_URL !== "https://plc.directory") throw new Error("Automatic public onboarding requires the canonical PLC registry");
  const hostname = env.MONITOR_API_HOST || "127.0.0.1", port = Number(env.MONITOR_API_PORT || "3001");
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(hostname) || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    env.MONITOR_API_PORT && String(port) !== env.MONITOR_API_PORT) throw new Error("Invalid private monitor API listener");
  return { hostname, port, monitorOrigin: origin(env.MONITOR_ORIGIN),
    apiOrigin: origin(env.MONITOR_API_ORIGIN || env.MONITOR_ORIGIN) };
}

// No activation, key export, arbitrary PLC updates or expectation approval API.
export function createMonitorEnrollmentApi(config: MonitorEnrollmentConfig, monitor: PlcMonitor, signer: MonitorSigner,
  providers: Pick<EnrollmentProviders, "authenticate">,
  request: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    new PinnedHttpsClient().post(url, init.body as Uint8Array, init.headers as Record<string, string>)) {
  origin(config.monitorOrigin);
  const active = new Set<string>();
  let windowStart = 0, requests = 0, authenticating = 0;
  const json = (value: unknown, status = 200) => Response.json(value, { status,
    headers: { "Cache-Control": "no-store", ...(status === 202 || status === 429 ? { "Retry-After": "15" } : {}) } });
  return { async fetch(input: Request): Promise<Response> {
    const stopping = new URL(input.url).pathname === "/api/v1/onboarding/stop";
    if (!stopping && new URL(input.url).pathname !== "/api/v1/onboarding") return json({ error: "Not found" }, 404);
    if (input.method !== "POST") return json({ error: "Use POST" }, 405);
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
    if (++requests > 600) return json({ error: "Enrollment rate limited" }, 429);
    if (active.size + authenticating >= 4) return json({ error: "Enrollment busy; retry original request" }, 429);
    let provider: EnrollmentProvider;
    authenticating++;
    try { provider = await providers.authenticate(input); }
    catch (error) {
      return json({ error: error instanceof ProviderAdmissionError ? error.message : "Enrollment temporarily unavailable" },
        error instanceof ProviderAdmissionError ? error.status : 503);
    } finally { authenticating--; }
    if (active.has(provider.id) || active.size >= 4) return json({ error: "Enrollment busy; retry original request" }, 429);
    active.add(provider.id);
    try {
      if (input.headers.get("Content-Type") !== "application/json" || input.headers.has("Content-Encoding"))
        return json({ error: "Use uncoded JSON" }, 415);
      if (stopping) {
        let did: string, operationCid: string;
        try {
          const bytes = await boundedBody(input, 1024);
          if (!bytes) return json({ error: "Stop request exceeds limit" }, 413);
          const row = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
          if (!row || Array.isArray(row) || Object.keys(row).sort().join(",") !== "did,operationCid" ||
            typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) || typeof row.operationCid !== "string") throw new Error();
          const cid = CID.parse(row.operationCid);
          if (cid.toString() !== row.operationCid || cid.code !== 0x71 || cid.multihash.code !== 0x12 || cid.multihash.digest.length !== 32) throw new Error();
          did = row.did; operationCid = row.operationCid;
        } catch { return json({ error: "Invalid managed monitoring stop request" }, 400); }
        try {
          await monitor.stopManaged(did, operationCid, provider.provider_origin, `${provider.alert_origin}${SIGNUP_ALERT_PATH}`, provider.id);
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        } catch { return json({ error: "Managed monitoring stop refused or unavailable" }, 409); }
      }
      let query: MonitorEmailBindingQuery, state: NonNullable<Awaited<ReturnType<typeof validateOperationLog>>>;
      try {
        const bytes = await boundedBody(input, 32_768);
        if (!bytes) return json({ error: "Enrollment request exceeds limit" }, 413);
        const row = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
        if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 ||
          Object.keys(row).some(key => !["signupId", "signupHash", "operation"].includes(key))) throw new Error();
        const operation = def.operation.strict().parse(row.operation);
        if (encodeDagCbor(operation).length > 7500 || operation.prev !== null || operation.rotationKeys.length !== 2 || operation.alsoKnownAs.length ||
          Object.keys(operation.verificationMethods).length !== 2 || Object.keys(operation.services).length !== 1 ||
          operation.services.hail?.type !== "HailMessaging" || operation.services.hail.endpoint !== `${provider.provider_origin}/hail` ||
          new Set([...operation.rotationKeys, ...Object.values(operation.verificationMethods)]).size !== 4 ||
          operation.rotationKeys.some(key => ![P256_JWT_ALG, SECP256K1_JWT_ALG].includes(parseDidKey(key).jwtAlg))) throw new Error();
        for (const role of ["hail-identity", "hail-messaging"]) {
          const key = operation.verificationMethods[role];
          if (!key?.startsWith("did:key:")) throw new Error();
          const raw = base58btc.decode(key.slice(8));
          if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 1) throw new Error();
        }
        // A valid lower-priority provider signature is not owner authorization.
        await assureValidSig([operation.rotationKeys[0]!], operation);
        const did = await didForCreateOp(operation), validated = await validateOperationLog(did, [operation]);
        if (!validated) throw new Error();
        state = validated;
        const candidate = { type: "hail.plc-monitor-email-binding", version: 1, signupId: row.signupId, signupHash: row.signupHash,
          did, operationCid: (await cidForCbor(operation)).toString(), issuedAt: Math.floor(now / 1000) };
        checkEmailBindingQuery(candidate, Math.floor(now / 1000)); query = candidate;
      } catch { return json({ error: "Enrollment requires an exact owner-signed managed genesis" }, 400); }

      // Independently confirm the consumer destination at the pinned receiver.
      // The monitor uses its existing signing key, not the provider's email secret.
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(query));
        const response = await request(`${provider.alert_origin}${SIGNUP_BINDING_PATH}`, { method: "POST", redirect: "error",
          signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", "X-Hail-Monitor-Key": signer.publicDidKey,
            "X-Hail-Monitor-Signature": encodeBase64Url(signer.signEmailBindingRequest(bytes)) }, body: bytes });
        if (!response.ok) { await response.body?.cancel(); return json({ error: "Verified consumer email binding unavailable" }, response.status === 409 ? 409 : 503); }
        const resultBytes = await boundedBody(response, 4096);
        if (!resultBytes) throw new Error();
        const result = parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes)) as Record<string, unknown>;
        if (!result || Object.keys(result).length !== 3 || result.bound !== true || result.did !== query.did || result.operationCid !== query.operationCid) throw new Error();
      } catch { return json({ error: "Consumer email receiver unavailable" }, 503); }
      const status = { did: query.did, operationCid: query.operationCid, monitorOrigin: config.monitorOrigin,
        monitorPublicKey: signer.publicDidKey, monitorAssurance: "reduced-assurance-alpha-v1" };
      try {
        await monitor.enroll(query.did, query.operationCid, `${provider.alert_origin}${SIGNUP_ALERT_PATH}`, state, provider.id);
        await monitor.pollDid(query.did);
        const signed = await monitor.attestOnboarding(query.did, query.operationCid, config.monitorOrigin, signer);
        return json({ ...status, state: "ready", attestation: { payload: encodeBase64Url(signed.payloadBytes), signature: encodeBase64Url(signed.signature) } });
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return json({ error: error.message }, error.status);
        if (error instanceof OnboardingMonitorPending) return json({ ...status, state: "awaiting-monitor" }, 202);
        return json({ error: "Retained bootstrap or monitor coverage refused; do not change genesis" }, 409);
      }
    } finally { active.delete(provider.id); }
  } };
}
