# hailctl

Installs and operates a Hail provider from a signed provider release.

```bash
curl -fsSL https://get.racrproto.com | sh
```

To install a specific release instead of the newest, name it:
`curl -fsSL https://get.racrproto.com/provider-v0.2.0 | sh`.

## Requirements

- Ubuntu 26.04 LTS or Debian 13, on amd64 or arm64, with root access.
- At least 2 GiB of memory and 10 GiB of free disk.
- Ports 80 and 443 free and reachable from the internet. `hailctl` runs its own
  HTTPS server (Caddy) and obtains certificates automatically.
- Two DNS names for this server: an **API hostname** (such as `svr.example.com`) and
  a **web hostname**, which is also the address domain (such as `example.com`, for
  addresses like `alice@example.com`).
- An email address you can read during the install.

## What `hailctl install` does

1. Checks the server, and offers to install Docker from Docker's official apt repository.
2. Asks for the two hostnames, a provider ID and your operator email.
3. Shows the DNS records to create (A/AAAA for both hostnames and the
   `_hail-provider` TXT record) and waits until public DNS has them.
4. Downloads the newest provider release, verifies its signed manifest against the
   key built into `hailctl`, checks the bundle checksum, and unpacks it into
   `/opt/hail-provider/release`.
5. Writes `/opt/hail-provider/.env` with fresh secrets. You confirm that you have
   stored `KEY_ENCRYPTION_KEY` offline: without it a database backup is useless.
6. Starts the provider and web client and waits until both hostnames serve HTTPS.
7. Registers with the shared monitor: it publishes a verification document, the
   monitor emails a code to your operator address, you enter it, and the monitor
   issues the credentials for signup email and identity monitoring.
8. Creates the provider recovery key (shown once; store it offline), then the
   `admin@` service account, and prints a link to create its passkey.

Each step is recorded in `/opt/hail-provider/hailctl.json`. If anything stops the
install, run `hailctl install` again; it resumes where it stopped and never
regenerates secrets.

## Unattended installs

Pass an answers file:

```toml
api_host = "svr.example.com"
web_host = "example.com"
provider_id = "example"
operator_email = "ops@example.com"
# Write secrets that must be backed up to /opt/hail-provider/BACK-UP-THESE-SECRETS.txt
# (root-only) instead of showing them. Copy them offline, then delete that file.
secrets_to_file = true
```

```bash
hailctl install --answers answers.toml
```

The emailed operator code is still required: `hailctl` reads it from
`HAILCTL_OPERATOR_CODE` or from one line on standard input.

## Other commands

| Command | Purpose |
| --- | --- |
| `hailctl status` | Installed release, container health and HTTPS readiness |
| `hailctl upgrade [--release provider-vX.Y.Z]` | Verify and install a newer release; restores the previous one if it fails to start (database migrations are not rolled back). Older releases are refused: they may not understand a database a newer release has migrated |
| `hailctl admin passkey-link` | A new single-use, ten-minute passkey link for `admin@` |
| `hailctl service-account create NAME` | Create a reserved service account such as `abuse` |

## Verification chain

`install.sh` belongs to one release. It downloads that release's manifest and
signature, verifies the signature with `openssl` against the pinned public key, and
installs `hailctl` only if its SHA-256 matches the signed manifest. `hailctl` embeds
the same key and verifies every release it installs or upgrades to. The images are
pulled by the immutable digests in the signed manifest. The release key's public half
is `apps/server/deploy/release/provider-release-signing.did`; see
[provider releases](../../agents/release-process.md#provider-releases).

## Not yet included

- Backups. Back up `/opt/hail-provider/.env` and the PostgreSQL volume
  (`hail-provider_provider_db`) yourself until `hailctl backup` exists.
- Running behind an existing reverse proxy or tunnel. `hailctl` requires direct
  public ports 80 and 443; see the [standalone guide](../server/deploy/standalone/README.md)
  for manual deployments.

## Development

```bash
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

Release binaries are static (`*-unknown-linux-musl`) and built by
`.github/workflows/release-provider.yml`. The crate version must equal the provider
release version in `apps/server/package.json`. `install.sh` is tested end to end by
`apps/server/test/provider-installer.test.ts`.
