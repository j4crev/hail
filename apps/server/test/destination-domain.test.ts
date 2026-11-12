import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertDestinationDomain, isCanonicalAddressDomain, transferEndpoint } from "../src/migration/destination-domain.js";
import { signHandshake, type TransferGrant } from "../src/migration/handshake.js";

const serviceBase = "https://svr.example.org/hail";

describe("split-domain transfer destinations", () => {
  it("accepts a co-hosted address domain without DNS", async () => {
    await expect(assertDestinationDomain("svr.example.org", serviceBase,
      async () => { throw new Error("no lookup expected"); })).resolves.toBeUndefined();
  });

  it("accepts an address domain whose _hail-provider record names the service host", async () => {
    const lookups: string[] = [];
    await expect(assertDestinationDomain("example.org", serviceBase,
      async domain => { lookups.push(domain); return "svr.example.org"; })).resolves.toBeUndefined();
    expect(lookups).toEqual(["example.org"]);
  });

  it("rejects missing, foreign or unavailable delegation", async () => {
    await expect(assertDestinationDomain("example.org", serviceBase, async () => null))
      .rejects.toThrow("not delegated");
    await expect(assertDestinationDomain("example.org", serviceBase, async () => "svr.attacker.example"))
      .rejects.toThrow("not delegated");
    await expect(assertDestinationDomain("example.org", serviceBase, async () => { throw new Error("SERVFAIL"); }))
      .rejects.toThrow("unavailable");
  });

  it("requires a canonical domain before any lookup", async () => {
    for (const domain of ["Example.org", "example.org:443", "example.org/x", "127.0.0.1", "", "localhost"]) {
      expect(isCanonicalAddressDomain(domain)).toBe(false);
      await expect(assertDestinationDomain(domain, serviceBase, async () => "svr.example.org"))
        .rejects.toThrow("not canonical");
    }
  });

  it("addresses provider transfer endpoints at the service-base origin, not the address domain", () => {
    expect(transferEndpoint(serviceBase, "invitations").href)
      .toBe("https://svr.example.org/.well-known/hail/transfers/invitations");
  });

  it("signs portable grants whose address domain differs from the service host", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const now = Math.floor(Date.now() / 1000);
    const grant: TransferGrant = { type: "hail.transfer-grant", version: 1, did: `did:plc:${"a".repeat(24)}`,
      nonce: randomUUID(), source_service_base: "https://svr.source.example.net/hail",
      destination_service_base: serviceBase, destination_domain: "example.org", issued_at: now, expires_at: now + 3600 };
    await expect(signHandshake(grant, pair.privateKey)).resolves.toBeDefined();
    await expect(signHandshake({ ...grant, destination_domain: "Example.org" }, pair.privateKey))
      .rejects.toThrow("not canonical");
  });
});
