import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeRelease, hailiDeployCommand, publicDidKey, releaseTag, signRelease, verifyRelease,
  type ProviderRelease } from "../src/release/provider-release.js";

const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version as string;
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const keys = generateKeyPairSync("ed25519");
const pem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), did = publicDidKey(keys.publicKey);
const image = (repository: string, base: number) => ({ repository, digest: digest(base),
  platforms: { "linux/amd64": digest(base + 1), "linux/arm64": digest(base + 2) } });
const release: ProviderRelease = { type: "hail.provider-release", version: 2, release: "0.1.0", tag: "provider-v0.1.0",
  commit: "a".repeat(40), images: { provider: image("ghcr.io/j4crev/hail/provider", 1),
    webClient: image("ghcr.io/j4crev/hail/provider-web-client", 4) },
  tools: { hailctl: { "linux/amd64": "1".repeat(64), "linux/arm64": "2".repeat(64) } },
  bundle: { name: "hail-provider-0.1.0.tar.gz", sha256: "f".repeat(64) }, createdAt: "2026-11-13T00:00:00.000Z" };

describe("provider release manifest", () => {
  it("signs exact bytes and refuses tampering, other keys and non-canonical encodings", () => {
    const bytes = encodeRelease(release), signature = signRelease(bytes, pem);
    expect(verifyRelease(bytes, signature + "\n", did)).toEqual(release);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(digest(1), digest(7)));
    expect(() => verifyRelease(tampered, signature, did)).toThrow("signature is invalid");
    const other = publicDidKey(generateKeyPairSync("ed25519").publicKey);
    expect(() => verifyRelease(bytes, signature, other)).toThrow("signature is invalid");
    const compact = new TextEncoder().encode(JSON.stringify(release));
    expect(() => verifyRelease(compact, signRelease(compact, pem), did)).toThrow("not canonical");
  });

  it("validates every field before encoding", () => {
    for (const bad of [{ ...release, tag: "provider-v0.2.0" }, { ...release, release: "1.0" }, { ...release, commit: "abc" },
      { ...release, bundle: { ...release.bundle, name: "other.tar.gz" } },
      { ...release, images: { ...release.images, provider: { ...release.images.provider, repository: "docker.io/x/provider" } } },
      { ...release, images: { ...release.images, provider: { ...release.images.provider, platforms: { "linux/amd64": digest(2) } } } },
      { ...release, tools: { hailctl: { "linux/amd64": "1".repeat(64) } } }, { ...release, version: 1 },
      { ...release, extra: true }])
      expect(() => encodeRelease(bad as ProviderRelease)).toThrow("Invalid provider release manifest");
    expect(() => releaseTag("v1.2.3")).toThrow();
    expect(releaseTag("12.0.3")).toBe("provider-v12.0.3");
  });

  it("gives Haili's wrapper the amd64 images, as before multi-platform releases", () => {
    expect(hailiDeployCommand(release)).toBe(`hail-provider-ops deploy ${"a".repeat(40)} ` +
      `ghcr.io/j4crev/hail/provider@${digest(2)} ghcr.io/j4crev/hail/provider-web-client@${digest(5)}\n`);
  });
});

describe("provider release CLI", () => {
  let out: string;
  const cli = new URL("../src/cli/provider-release.ts", import.meta.url).pathname;

  const env: Record<string, string | undefined> = { ...process.env, PROVIDER_RELEASE_SIGNING_DID: did, PROVIDER_RELEASE_SIGNING_KEY: pem,
    RELEASE_TAG: `provider-v${version}`, RELEASE_COMMIT: "b".repeat(40),
    RELEASE_PROVIDER_REPOSITORY: "ghcr.io/j4crev/hail/provider", RELEASE_PROVIDER_DIGEST: digest(1),
    RELEASE_PROVIDER_AMD64_DIGEST: digest(2), RELEASE_PROVIDER_ARM64_DIGEST: digest(3),
    RELEASE_CLIENT_REPOSITORY: "ghcr.io/j4crev/hail/provider-web-client", RELEASE_CLIENT_DIGEST: digest(4),
    RELEASE_CLIENT_AMD64_DIGEST: digest(5), RELEASE_CLIENT_ARM64_DIGEST: digest(6) };
  const run = async (args: string[], environment: Record<string, string | undefined> = env) => {
    const child = Bun.spawn(["bun", cli, ...args], { env: environment, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "provider-release-test-"));
    await mkdir(join(out, "bin"));
    for (const arch of ["amd64", "arm64"]) await writeFile(join(out, "bin", `hailctl-linux-${arch}`), `fake hailctl ${arch}\n`);
    env.RELEASE_HAILCTL_DIR = join(out, "bin");
  });
  afterAll(async () => { await rm(out, { recursive: true, force: true }); });

  it("accepts only the tag matching the server package version", async () => {
    expect((await run(["check-tag", `provider-v${version}`])).code).toBe(0);
    expect((await run(["check-tag", `v${version}`])).code).not.toBe(0);
    expect((await run(["check-tag", "provider-v99.0.0"])).code).not.toBe(0);
  });

  it("builds a reproducible bundle and a signed manifest that verifies, and detects tampering", async () => {
    const first = join(out, "first"), second = join(out, "second");
    expect((await run(["build", first])).code).toBe(0);
    expect((await run(["build", second])).code).toBe(0);
    const name = `hail-provider-${version}.tar.gz`;
    expect(Buffer.compare(await readFile(join(first, name)), await readFile(join(second, name)))).toBe(0);
    const listing = Bun.spawnSync(["tar", "-tzf", join(first, name)]).stdout.toString().trim().split("\n").sort();
    expect(listing).toEqual([`hail-provider-${version}/`, ...[".env.example", "Caddyfile", "Caddyfile.tunnel", "Caddyfile.web-client", "README.md",
      "compose.tunnel.yaml", "compose.web-client.yaml", "compose.yaml", "release.env"].map(file => `hail-provider-${version}/${file}`)].sort());
    const pins = Bun.spawnSync(["tar", "-xzOf", join(first, name), `hail-provider-${version}/release.env`]).stdout.toString();
    expect(pins).toContain(`HAIL_PROVIDER_IMAGE=ghcr.io/j4crev/hail/provider@${digest(1)}`);
    expect(pins).toContain(`HAIL_WEB_CLIENT_IMAGE=ghcr.io/j4crev/hail/provider-web-client@${digest(4)}`);
    const sums = await readFile(join(first, "SHA256SUMS"), "utf8");
    expect(sums.trim().split("\n").map(line => line.split("  ")[1]).sort())
      .toEqual([name, "provider-release.json", "provider-release.json.sig", "provider-release.txt", "install.sh",
        "hailctl-linux-amd64", "hailctl-linux-arm64"].sort());
    const installer = await readFile(join(first, "install.sh"), "utf8");
    expect(installer).toContain(`tag='provider-v${version}'`);
    expect(installer).toContain("-----BEGIN PUBLIC KEY-----");
    expect(installer).not.toMatch(/@[A-Z_]+@/);
    const verified = await run(["verify", first]);
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ verified: true, commit: "b".repeat(40) });
    await writeFile(join(first, "hailctl-linux-arm64"), "tampered");
    expect((await run(["verify", first])).stderr).toContain("hailctl-linux-arm64 does not match");
    await writeFile(join(first, "hailctl-linux-arm64"), "fake hailctl arm64\n");
    await writeFile(join(first, name), "tampered");
    expect((await run(["verify", first])).stderr).toContain("Bundle checksum does not match");
    expect((await run(["verify", second], { ...env, PROVIDER_RELEASE_SIGNING_DID: publicDidKey(generateKeyPairSync("ed25519").publicKey) })).code).not.toBe(0);
  });

  it("refuses a signing key that does not match the pinned key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const result = await run(["build", join(out, "mismatch")], { ...env, PROVIDER_RELEASE_SIGNING_KEY: other });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("signature is invalid");
  });
});
