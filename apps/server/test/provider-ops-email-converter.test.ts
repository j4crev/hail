/**
 * Exercises the Haili release wrapper with docker, git and curl stubbed, under
 * the system /bin/sh. Its host paths are moved into a temporary directory.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url).pathname, deploy = join(here, "../deploy");
const work = mkdtempSync(join(tmpdir(), "provider-ops-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const COMMIT = "a".repeat(40), OLD_COMMIT = "b".repeat(40), PASSWORD = "p".repeat(43);
const PROVIDER = `ghcr.io/j4crev/hail/provider@sha256:${"c".repeat(64)}`, CLIENT = `ghcr.io/j4crev/hail/provider-web-client@sha256:${"d".repeat(64)}`;
const id = (n: number) => `sha256:${String(n).padStart(64, "0")}`;

const stubs: Record<string, string> = {
  docker: `#!/bin/sh
echo "docker $*" >> "$T/calls"
case "$1" in
  compose) shift; while [ "$1" = "--env-file" ] || [ "$1" = "-f" ]; do shift 2; done
    case "$1" in
      exec) cat > "$T/psql-input";;
      up) case "$*" in *email-converter*) touch "$T/converter-started";; esac;;
    esac; exit 0;;
  image) case "$*" in
      *revision*) echo "${COMMIT}";;
      *"{{.Id}}"*) ref=$3; case "$ref" in *rollback-*) echo "sha256:\${ref##*rollback-}";; *) echo "${id(9)}";; esac;;
    esac;;
  inspect) case "$2" in
      hail-public-provider-provider-1) echo "${id(1)}";;
      hail-public-provider-gui-1) echo "${id(2)}";;
      hail-public-provider-email-converter-1) [ -f "$T/converter-running" ] || [ -f "$T/converter-started" ] || exit 1
        case "$*" in *"{{.Image}}"*) if [ -f "$T/converter-mismatch" ]; then echo "${id(7)}"; else echo "${id(1)}"; fi;; esac;;
    esac;;
  info) echo "$T";;
esac
exit 0`,
  git: `#!/bin/sh\necho "git $*" >> "$T/calls"\ncase "$*" in *"rev-parse HEAD"*) echo "${OLD_COMMIT}";; esac\nexit 0`,
  curl: `#!/bin/sh\nexit 0`, flock: `#!/bin/sh\nexit 0`,
  df: `#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use% Mounted"\necho "x 1 1 99999999 1% /"`,
};
const bin = join(work, "bin");
mkdirSync(bin);
for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(bin, name), body + "\n"); chmodSync(join(bin, name), 0o755); }
const script = join(work, "ops.sh");
writeFileSync(script, readFileSync(join(deploy, "public/provider-ops.sh"), "utf8")
  .replaceAll("/opt/hail", "$T/opt/hail").replaceAll("/etc/hail-provider", "$T/etc/hail-provider")
  .replaceAll("/var/lib/hail-provider", "$T/var/lib/hail-provider").replaceAll("/usr/local/sbin/hail-provider-backup", "$T/backup"));
const withConverter = readFileSync(join(deploy, "public/compose.yaml"), "utf8");
const withoutConverter = withConverter.replace(/\n  # Optional email bridge converter[\s\S]*?\n\n  db:/, "\n\n  db:");

interface Scenario { compose?: string; password?: string; running?: boolean; released?: boolean; mismatch?: boolean }
async function run(name: string, args: string[], { compose = withConverter, password = PASSWORD, running = false, released = false, mismatch = false }: Scenario = {}) {
  const T = join(work, name), app = join(T, "opt/hail/apps/server/deploy");
  mkdirSync(join(app, "public"), { recursive: true });
  cpSync(join(deploy, "email-bridge"), join(app, "email-bridge"), { recursive: true });
  writeFileSync(join(app, "public/compose.yaml"), compose);
  writeFileSync(join(app, "public/.env"), `PROVIDER_DOMAIN=svr.example\nEMAIL_CONVERTER_DB_PASSWORD=${password}\n`);
  writeFileSync(join(T, "backup"), "#!/bin/sh\nexit 0\n"); chmodSync(join(T, "backup"), 0o755);
  mkdirSync(join(T, "var/lib"), { recursive: true });
  writeFileSync(join(T, "var/lib/hail-provider-previous"),
    `${OLD_COMMIT} hail-server-ts:rollback-${id(3).slice(7)} ${id(3)} hail-web-client:rollback-${id(4).slice(7)} ${id(4)}\n`);
  if (running) writeFileSync(join(T, "converter-running"), "");
  if (mismatch) writeFileSync(join(T, "converter-mismatch"), "");
  // A selection written by the earlier wrapper: provider and GUI only.
  if (released) { mkdirSync(join(T, "etc/hail-provider-release"), { recursive: true });
    writeFileSync(join(T, "etc/hail-provider-release/compose.json"), JSON.stringify({ services: { provider: { image: PROVIDER }, gui: { image: CLIENT } } })); }
  const child = Bun.spawn(["/bin/sh", script, ...args], { env: { T, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const [status, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const calls = existsSync(join(T, "calls")) ? readFileSync(join(T, "calls"), "utf8") : "";
  const releaseFile = join(T, "etc/hail-provider-release/compose.json");
  return {
    status, output, calls,
    started: calls.match(/--wait-timeout 180 (.*)$/m)?.[1] ?? null,
    stopped: calls.includes("docker stop hail-public-provider-email-converter-1"),
    release: existsSync(releaseFile) ? JSON.parse(readFileSync(releaseFile, "utf8")) as { services: Record<string, { image: string }> } : null,
    psql: existsSync(join(T, "psql-input")) ? readFileSync(join(T, "psql-input"), "utf8") : null,
  };
}
const deployArgs = ["deploy", COMMIT, PROVIDER, CLIENT];

describe("provider-ops email converter management", () => {
  it("starts the converter with the provider's release digest when its password is set", async () => {
    const result = await run("on", deployArgs);
    expect(result.status).toBe(0);
    expect(result.started).toBe("gui provider email-converter");
    expect(result.release?.services["email-converter"]?.image).toBe(PROVIDER);
  });

  it("leaves the converter off without a well-formed password, but still pins its image", async () => {
    for (const [name, password] of [["unset", ""], ["short", "short"], ["quoted", `${"p".repeat(42)}'`]] as const) {
      const result = await run(name, deployArgs, { password });
      expect(result.status).toBe(0);
      expect(result.started).toBe("gui provider");
      expect(result.release?.services["email-converter"]?.image).toBe(PROVIDER);
    }
  });

  it("stops a running converter and never names it when the release does not define it", async () => {
    const deployed = await run("old-release", deployArgs, { compose: withoutConverter, running: true });
    expect(deployed.status).toBe(0);
    expect(deployed.started).toBe("gui provider");
    expect(deployed.stopped).toBe(true);
    expect(Object.keys(deployed.release!.services)).toEqual(["provider", "gui"]);
    const rolledBack = await run("rollback-old", ["rollback"], { compose: withoutConverter, running: true });
    expect(rolledBack.status).toBe(0);
    expect(rolledBack.started).toBe("gui provider");
    expect(rolledBack.stopped).toBe(true);
  });

  it("rolls the converter back with the provider's retained image", async () => {
    const result = await run("rollback", ["rollback"]);
    expect(result.status).toBe(0);
    expect(result.started).toBe("gui provider email-converter");
    expect(result.release?.services["email-converter"]?.image).toBe(`hail-server-ts:rollback-${id(3).slice(7)}`);
  });

  it("creates the converter role from .env through standard input only", async () => {
    const result = await run("role", ["email-converter-role"], { released: true });
    expect(result.status).toBe(0);
    expect(result.psql?.split("\n")[0]).toBe(`\\set password '${PASSWORD}'`);
    expect(result.psql).toContain("CREATE ROLE hail_email_converter NOLOGIN");
    expect(result.psql).toContain("GRANT hail_email_converter TO email_converter");
    expect(result.calls).not.toContain(PASSWORD);
    expect(result.started).toBe("email-converter");
    // Pinned to the selected provider image before it starts, never a fallback tag.
    expect(result.release?.services).toEqual({ provider: { image: PROVIDER }, gui: { image: CLIENT }, "email-converter": { image: PROVIDER } });
    const mismatched = await run("role-mismatch", ["email-converter-role"], { released: true, mismatch: true });
    expect(mismatched.status).toBe(1);
    expect(mismatched.output).toContain("differs from the provider");
    expect(mismatched.stopped).toBe(true);
    expect((await run("role-unreleased", ["email-converter-role"])).output).toContain("deploy first");
    expect((await run("role-unset", ["email-converter-role"], { password: "", released: true })).status).toBe(1);
  });

  it("serves converter logs", async () => {
    const result = await run("logs", ["logs", "email-converter", "50"]);
    expect(result.status).toBe(0);
    expect(result.calls).toContain("logs --no-color --tail 50 email-converter");
  });
});
