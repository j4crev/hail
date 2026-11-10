import { ProviderAdmissionError } from "../src/providers.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { P256Keypair } from "@atproto/crypto";
import { signOperation } from "@did-plc/lib";
import { encodeBase64Url } from "@racrproto/codec/base64url";
import { base58btc } from "multiformats/bases/base58";
import { expect, it, vi } from "vitest";
import { createMonitorEnrollmentApi, monitorEnrollmentConfig } from "../src/enrollment.js";
import { MonitorSigner } from "../src/signing.js";
import { OnboardingMonitorPending } from "../src/monitor.js";

it("matches the published provider registration document vector", async () => {
  const { registrationDocument } = await import("../src/provider-registration.js");
  const vector = await Bun.file(new URL("../../../spec/vectors/monitor-provider-registration.json", import.meta.url)).json();
  expect(await registrationDocument({ ...vector.request, monitorApiOrigin: vector.document.monitorApiOrigin })).toEqual(vector.document);
});

it("keeps the listener off by default and validates every enrollment declaration before startup", () => {
  expect(monitorEnrollmentConfig({ MONITOR_ORIGIN: "https://monitor.example.com" })).toBeUndefined();
  const env = { MONITOR_API_HOST: "127.0.0.1", MONITOR_ORIGIN: "https://monitor.example.com", PLC_DIRECTORY_URL: "https://plc.directory" };
  expect(monitorEnrollmentConfig(env)).toMatchObject({ hostname: "127.0.0.1", port: 3001 });
  for (const change of [{ MONITOR_ENROLLMENT_TOKEN: "bad" },
    { MONITOR_ENROLLMENT_PROVIDER: "http://provider.example.com" }, { MONITOR_ENROLLMENT_ALERT_ORIGIN: "https://alerts.example.com/path" },
    { MONITOR_ORIGIN: undefined }, { MONITOR_API_HOST: "example.com" }, { MONITOR_API_PORT: "03001" }, { MONITOR_API_PORT: "80" },
    { PLC_DIRECTORY_URL: "http://private-plc.example.com" }])
    expect(() => monitorEnrollmentConfig({ ...env, ...change })).toThrow();
});

it("authenticates and bounds requests and refuses a provider-signed genesis without owner authority", async () => {
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey), enroll = vi.fn(), request = vi.fn();
  const pollDid = vi.fn(), attestOnboarding = vi.fn();
  const config = { token: encodeBase64Url(randomBytes(32)), providerOrigin: "https://provider.example.com", alertOrigin: "https://alerts.example.com",
    monitorOrigin: "https://monitor.example.com", hostname: "127.0.0.1", port: 3001 };
  const api = createMonitorEnrollmentApi(config, { enroll, pollDid, attestOnboarding } as never, signer, credentials(config), request);
  const invoke = (body: string, token = config.token) => api.fetch(new Request("https://monitor.example.com/api/v1/onboarding", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body,
  }));
  expect((await invoke("{}", "wrong")).status).toBe(401);
  expect((await invoke(" ".repeat(32_769))).status).toBe(413);
  expect((await invoke("null")).status).toBe(400);
  const owner = await P256Keypair.create(), provider = await P256Keypair.create();
  const ed = () => { const raw = new Uint8Array(34); raw.set([0xed, 1]); raw.set(randomBytes(32), 2); return `did:key:${base58btc.encode(raw)}`; };
  const unsigned = { type: "plc_operation" as const, prev: null, rotationKeys: [owner.did(), provider.did()],
    verificationMethods: { "hail-identity": ed(), "hail-messaging": ed() }, alsoKnownAs: [],
    services: { hail: { type: "HailMessaging", endpoint: "https://provider.example.com/hail" } } };
  const input = { signupId: randomUUID(), signupHash: encodeBase64Url(randomBytes(32)), operation: await signOperation(unsigned, provider) };
  expect((await invoke(JSON.stringify(input))).status).toBe(400);
  expect((await invoke(JSON.stringify({ ...input, operation: await signOperation(unsigned, owner), alertUrl: "https://attacker.example.com" }))).status).toBe(400);
  expect(enroll).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(pollDid).not.toHaveBeenCalled();
  request.mockImplementation(async (_url, init) => {
    const query = JSON.parse(new TextDecoder().decode(init.body));
    return Response.json({ bound: true, did: query.did, operationCid: query.operationCid });
  });
  const calls: string[] = [];
  enroll.mockImplementation(async () => { calls.push("enroll"); });
  pollDid.mockImplementation(async () => { calls.push("poll"); });
  attestOnboarding.mockImplementation(async () => { calls.push("attest"); throw new OnboardingMonitorPending(); });
  const valid = JSON.stringify({ ...input, operation: await signOperation(unsigned, owner) });
  // Check immediately, but still wait for the signed coverage and email receipt.
  expect((await invoke(valid)).status).toBe(202);
  expect(calls).toEqual(["enroll", "poll", "attest"]);
  expect(pollDid).toHaveBeenCalledWith(enroll.mock.calls[0]![0]);
  attestOnboarding.mockResolvedValue({ payloadBytes: new Uint8Array([1]), signature: new Uint8Array([2]) });
  expect((await invoke(valid)).status).toBe(200);
});

it("authenticates and validates managed stop requests without accepting arbitrary destinations", async () => {
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey), stopManaged = vi.fn();
  const config = { token: encodeBase64Url(randomBytes(32)), providerOrigin: "https://provider.example.com", alertOrigin: "https://alerts.example.com",
    monitorOrigin: "https://monitor.example.com", hostname: "127.0.0.1", port: 3001 };
  const api = createMonitorEnrollmentApi(config, { stopManaged } as never, signer, credentials(config));
  const { cidForCbor } = await import("@atproto/common");
  const body = { did: `did:plc:${"a".repeat(24)}`, operationCid: (await cidForCbor({ test: true })).toString() };
  const invoke = (value: unknown, token = config.token) => api.fetch(new Request(`${config.monitorOrigin}/api/v1/onboarding/stop`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(value),
  }));
  expect((await invoke(body, "wrong")).status).toBe(401);
  for (const invalid of [null, {}, { ...body, did: "bad" }, { ...body, operationCid: "bad" }, { ...body, alertOrigin: "https://other.example" }])
    expect((await invoke(invalid)).status).toBe(400);
  expect(stopManaged).not.toHaveBeenCalled();
  expect((await invoke(body)).status).toBe(204);
  expect(stopManaged).toHaveBeenCalledWith(body.did, body.operationCid, config.providerOrigin, `${config.alertOrigin}/hail/signup`, "provider-id");
  stopManaged.mockRejectedValue(new Error("Independent enrollment"));
  expect((await invoke(body)).status).toBe(409);
});


function credentials(config: { token: string; providerOrigin: string; alertOrigin: string }) {
  return { async authenticate(request: Request) {
    if (request.headers.get("authorization") !== `Bearer ${config.token}`)
      throw new ProviderAdmissionError(401, "Unauthorized");
    return { id: "provider-id", provider_origin: config.providerOrigin, alert_origin: config.alertOrigin,
      requests_per_minute: 60, max_identities: 100, enrollments_per_day: 20 };
  } };
}

it("bounds pending authentication before database work can fill an unbounded queue", async () => {
  const signer = new MonitorSigner(generateKeyPairSync("ed25519").privateKey);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const authenticate = vi.fn(async () => { await waiting; throw new ProviderAdmissionError(401, "Unauthorized"); });
  const api = createMonitorEnrollmentApi({ monitorOrigin: "https://monitor.example", hostname: "127.0.0.1", port: 3001 },
    {} as never, signer, { authenticate });
  const invoke = () => api.fetch(new Request("https://monitor.example/api/v1/onboarding", { method: "POST" }));
  const pending = [invoke(), invoke(), invoke(), invoke()];
  expect((await invoke()).status).toBe(429);
  expect(authenticate).toHaveBeenCalledTimes(4);
  release();
  expect((await Promise.all(pending)).every(response => response.status === 401)).toBe(true);
  expect((await invoke()).status).toBe(401);
});
