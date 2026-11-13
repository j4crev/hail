// Provider release tooling for .github/workflows/release-provider.yml and operators.
//   check-tag TAG                 tag must equal provider-v<apps/server/package.json version>
//   build OUT_DIR                 bundle, signed manifest, SHA256SUMS and Haili deploy command
//   verify DIR                    check a downloaded release against the pinned key
// `build` reads RELEASE_* image settings and PROVIDER_RELEASE_SIGNING_KEY from the environment.
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_FILES, PLATFORMS, bundleName, encodeRelease, hailiDeployCommand, releaseEnvironment, releaseTag,
  sha256Hex, signRelease, verifyRelease, type ProviderRelease, type ReleaseImage } from "../release/provider-release.js";

const server = new URL("../../", import.meta.url).pathname;
const standalone = join(server, "deploy/standalone");
// PROVIDER_RELEASE_SIGNING_DID overrides the pinned key for tests; the release workflow never sets it.
const pinnedKey = async () => process.env.PROVIDER_RELEASE_SIGNING_DID ??
  (await readFile(join(server, "deploy/release/provider-release-signing.did"), "utf8")).trim();
const packageVersion = async () => (JSON.parse(await readFile(join(server, "package.json"), "utf8")) as { version: string }).version;

async function run(command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr.trim()}`);
}

function image(prefix: "PROVIDER" | "CLIENT"): ReleaseImage {
  const env = (name: string) => {
    const value = process.env[`RELEASE_${prefix}_${name}`];
    if (!value) throw new Error(`RELEASE_${prefix}_${name} is required`);
    return value;
  };
  return { repository: env("REPOSITORY"), digest: env("DIGEST"),
    platforms: { "linux/amd64": env("AMD64_DIGEST"), "linux/arm64": env("ARM64_DIGEST") } };
}

/** A reproducible tar.gz: fixed order, owner and timestamps, gzip without a name or time. */
async function buildBundle(version: string, images: ProviderRelease["images"], out: string): Promise<string> {
  const stage = await mkdtemp(join(tmpdir(), "hail-provider-bundle-")), root = `hail-provider-${version}`;
  try {
    await mkdir(join(stage, root));
    for (const file of BUNDLE_FILES) await copyFile(join(standalone, file), join(stage, root, file));
    await writeFile(join(stage, root, "release.env"), releaseEnvironment(images));
    const tar = join(stage, "bundle.tar"), name = bundleName(version);
    await run(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--mode=u+rw,go+r,go-w",
      "-cf", tar, "-C", stage, root]);
    await run(["gzip", "-n", "-9", tar]);
    await copyFile(`${tar}.gz`, join(out, name));
    return name;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

const [command, argument, extra] = Bun.argv.slice(2);
if (command === "check-tag" && argument && !extra) {
  const expected = releaseTag(await packageVersion());
  if (argument !== expected) throw new Error(`Tag ${argument} must equal ${expected} (apps/server/package.json)`);
  console.info(JSON.stringify({ tag: argument, release: await packageVersion() }));
} else if (command === "build" && argument && !extra) {
  const tag = process.env.RELEASE_TAG ?? "", commit = process.env.RELEASE_COMMIT ?? "", key = process.env.PROVIDER_RELEASE_SIGNING_KEY;
  const version = await packageVersion();
  if (tag !== releaseTag(version)) throw new Error(`RELEASE_TAG must equal ${releaseTag(version)}`);
  if (!key) throw new Error("PROVIDER_RELEASE_SIGNING_KEY is required");
  await mkdir(argument, { recursive: true });
  const images = { provider: image("PROVIDER"), webClient: image("CLIENT") };
  const name = await buildBundle(version, images, argument);
  const release: ProviderRelease = { type: "hail.provider-release", version: 1, release: version, tag, commit, images,
    bundle: { name, sha256: sha256Hex(new Uint8Array(await readFile(join(argument, name)))) }, createdAt: new Date().toISOString() };
  const bytes = encodeRelease(release), signature = signRelease(bytes, key);
  verifyRelease(bytes, signature, await pinnedKey()); // the secret must match the key hailctl pins
  await writeFile(join(argument, "provider-release.json"), bytes);
  await writeFile(join(argument, "provider-release.json.sig"), signature + "\n");
  await writeFile(join(argument, "provider-release.txt"), hailiDeployCommand(release));
  const files = [name, "provider-release.json", "provider-release.json.sig", "provider-release.txt"];
  const sums = await Promise.all(files.map(async file => `${sha256Hex(new Uint8Array(await readFile(join(argument, file))))}  ${file}\n`));
  await writeFile(join(argument, "SHA256SUMS"), sums.join(""));
  console.info(JSON.stringify({ tag, commit, bundle: name, platforms: PLATFORMS }));
} else if (command === "verify" && argument && !extra) {
  const bytes = new Uint8Array(await readFile(join(argument, "provider-release.json")));
  const release = verifyRelease(bytes, await readFile(join(argument, "provider-release.json.sig"), "utf8"), await pinnedKey());
  const bundle = sha256Hex(new Uint8Array(await readFile(join(argument, release.bundle.name))));
  if (bundle !== release.bundle.sha256) throw new Error("Bundle checksum does not match the signed manifest");
  if (await readFile(join(argument, "provider-release.txt"), "utf8").catch(() => null) !== hailiDeployCommand(release))
    throw new Error("provider-release.txt does not match the signed manifest");
  console.info(JSON.stringify({ verified: true, tag: release.tag, commit: release.commit,
    provider: `${release.images.provider.repository}@${release.images.provider.digest}`,
    webClient: `${release.images.webClient.repository}@${release.images.webClient.digest}` }));
} else {
  throw new Error("Usage: bun src/cli/provider-release.ts check-tag TAG | build OUT_DIR | verify DIR");
}
