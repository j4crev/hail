// End-to-end check of apps/hailctl/install.sh against a release built by the real
// release CLI, served over local HTTPS: the script must verify the manifest
// signature with openssl and the binary hash before installing anything.
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicDidKey } from "../src/release/provider-release.js";

const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version as string;
const tag = `provider-v${version}`, digest = (n: number) => `sha256:${String(n).repeat(64)}`;
const arch = process.arch === "arm64" ? "arm64" : "amd64";
// Always asynchronous: synchronous spawns block the worker, and the HTTPS fixture
// that install.sh downloads from runs in this same process.
async function spawn(command: string[], env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stderr };
}

describe("install.sh", () => {
  let work: string, server: ReturnType<typeof Bun.serve>, releaseDir: string, certificate: string;
  const keys = generateKeyPairSync("ed25519");
  const cli = new URL("../src/cli/provider-release.ts", import.meta.url).pathname;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "hailctl-installer-"));
    releaseDir = join(work, "releases", tag);
    await mkdir(join(work, "bin")); await mkdir(join(work, "install"));
    for (const platform of ["amd64", "arm64"]) await writeFile(join(work, "bin", `hailctl-linux-${platform}`), `hailctl ${platform}\n`);
    const build = await spawn(["bun", cli, "build", releaseDir], { ...process.env,
      PROVIDER_RELEASE_SIGNING_DID: publicDidKey(keys.publicKey),
      PROVIDER_RELEASE_SIGNING_KEY: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      RELEASE_TAG: tag, RELEASE_COMMIT: "c".repeat(40), RELEASE_HAILCTL_DIR: join(work, "bin"),
      RELEASE_PROVIDER_REPOSITORY: "ghcr.io/j4crev/hail/provider", RELEASE_PROVIDER_DIGEST: digest(1),
      RELEASE_PROVIDER_AMD64_DIGEST: digest(2), RELEASE_PROVIDER_ARM64_DIGEST: digest(3),
      RELEASE_CLIENT_REPOSITORY: "ghcr.io/j4crev/hail/provider-web-client", RELEASE_CLIENT_DIGEST: digest(4),
      RELEASE_CLIENT_AMD64_DIGEST: digest(5), RELEASE_CLIENT_ARM64_DIGEST: digest(6) });
    expect(build.code, build.stderr).toBe(0);
    certificate = join(work, "cert.pem");
    const openssl = await spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
      "-keyout", join(work, "key.pem"), "-out", certificate]);
    expect(openssl.code, openssl.stderr).toBe(0);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(join(work, "key.pem")), cert: Bun.file(certificate) },
      fetch: request => {
        const path = decodeURIComponent(new URL(request.url).pathname);
        if (path.includes("..")) return new Response(null, { status: 400 });
        const file = Bun.file(join(work, "releases", path));
        return file.size ? new Response(file) : new Response(null, { status: 404 });
      } });
  });
  afterAll(async () => { server?.stop(true); await rm(work, { recursive: true, force: true }); });

  const install = () => spawn(["sh", join(releaseDir, "install.sh")], { ...process.env,
    CURL_CA_BUNDLE: certificate, HAILCTL_RELEASE_BASE: `https://localhost:${server.port}`,
    HAILCTL_INSTALL_DIR: join(work, "install"), HAILCTL_NO_RUN: "1" });
  const restore = async (file: string, content: Buffer) => { await writeFile(join(releaseDir, file), content); };

  it("installs the host's hailctl after verifying the signature and hash", async () => {
    const result = await install();
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("Verified hailctl from");
    expect(await readFile(join(work, "install", "hailctl"), "utf8")).toBe(`hailctl ${arch}\n`);
  });

  it("refuses a tampered binary, manifest or signature", async () => {
    await rm(join(work, "install", "hailctl"), { force: true });
    const binary = `hailctl-linux-${arch}`;
    for (const [file, tamper, message] of [
      [binary, (data: Buffer) => Buffer.concat([data, Buffer.from("x")]), "checksum does not match"],
      ["provider-release.json", (data: Buffer) => Buffer.from(data.toString().replace(digest(1), digest(7))), "signature verification failed"],
      ["provider-release.json.sig", () => Buffer.from(`${Buffer.alloc(64, 1).toString("base64url")}\n`), "signature verification failed"],
    ] as const) {
      const original = await readFile(join(releaseDir, file));
      await writeFile(join(releaseDir, file), tamper(original));
      const result = await install();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(message);
      await restore(file, original);
    }
    await expect(readFile(join(work, "install", "hailctl"))).rejects.toThrow();
    expect((await install()).code).toBe(0);
  });
});
