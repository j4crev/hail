# hailctl

Installs and operates a Hail provider from a signed provider release.

```bash
curl -fsSL https://get.racrproto.com | sh
```

To install a specific release instead of the newest, name it:
`curl -fsSL https://get.racrproto.com/provider-v0.3.0 | sh` (0.3.0 or later; the 0.2.0
installer cannot start a provider).

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
   `admin@` service account.
9. Schedules a daily backup, then prints a link to create the `admin@` passkey.

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
| `hailctl upgrade [--release provider-vX.Y.Z]` | Back up, then install a newer verified release (and the matching `hailctl`) |
| `hailctl rollback [--yes]` | Return to the release and data from just before the last upgrade |
| `hailctl backup` | Back up now |
| `hailctl backup list` | Local backups, the daily timer and the off-host bucket |
| `hailctl backup configure [--from FILE \| --remove]` | Copy every backup to an S3-compatible bucket |
| `hailctl restore FILE [--yes]` | Replace this provider's data (and release) with a backup's |
| `hailctl install --restore FILE` | Rebuild a provider from a backup on a new server |
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

## Backups

A backup is one file, `<provider>-<UTC time>-<reason>.tar.age`, in
`/opt/hail-provider/backups`. It holds a PostgreSQL dump, `.env` and `hailctl.json`,
encrypted with [age](https://age-encryption.org) using **`KEY_ENCRYPTION_KEY` as the
passphrase**. That key is left out of the file. Restoring therefore needs only the
backup and the key you stored offline at install. A copy of a backup that leaks is
useless without the key, and a lost key makes every backup useless. `age -d FILE`
decrypts one without `hailctl` (enter the key as the passphrase).

Each backup is read back and checked against its manifest before it is kept. They are
taken:

| When | Kept locally |
| --- | --- |
| Daily, by the `hail-provider-backup.timer` systemd timer | newest 7 |
| Before every upgrade, with the provider stopped so nothing is missed | newest 3, and always the current rollback point |
| Before a rollback or restore replaces the data | newest 3 |
| On demand with `hailctl backup` | newest 3 |

**Copy backups off the server.** A disk or server loss takes local backups with it.
`hailctl backup configure` asks for an S3-compatible bucket (Cloudflare R2, Backblaze
B2, AWS S3, MinIO). It checks that it can write, read and delete there and saves the
settings, credentials included, in `/opt/hail-provider/backup-remote.toml` (root
only). From then on every backup is uploaded and read back. A scheduled backup that
cannot be uploaded fails, so the timer shows it (`systemctl status
hail-provider-backup`). `hailctl` never deletes from the bucket, so set a lifecycle
rule that expires old objects. For unattended setup, pass the same settings as TOML:

```toml
endpoint = "https://<account id>.r2.cloudflarestorage.com"
bucket = "hail-backups"
region = "auto"          # the bucket's region outside R2
prefix = "example/"      # optional
access_key_id = "..."
secret_access_key = "..."
```

## Rolling back and restoring

Database migrations only run forward, so a provider is never downgraded in place.
Instead, `hailctl upgrade` stops the provider, takes a backup, and only then starts
the new release. If the new release does not start, `hailctl` restores that backup and
the previous release automatically.

If a problem shows up later, `hailctl rollback` returns to the release and data from
just before the upgrade. `hailctl restore FILE` does the same for any backup of this
provider. Both:

- verify the backup before changing anything, and ask for confirmation (`--yes` skips it);
- take a backup of the current data first, and return to it if the restore fails;
- lose everything written after the backup was taken: messages, new accounts and settings.

Identity changes published to the PLC directory since the backup, such as new accounts
or key rotations, cannot be undone. Accounts affected by them may need recovery.

### Moving to a new server

On the new server (Ubuntu 26.04 or Debian 13), with the old one stopped:

```bash
curl -fsSL https://get.racrproto.com/provider-v0.3.0 > install.sh
HAILCTL_NO_RUN=1 sh install.sh
hailctl install --restore example-20261112T030000Z-scheduled.tar.age
```

`hailctl` asks for `KEY_ENCRYPTION_KEY` (or reads `HAILCTL_KEY_ENCRYPTION_KEY`), and
restores the configuration and data. Point both hostnames' DNS at the new server.
`hailctl` then waits for DNS, starts the backup's release, and schedules backups. The
monitor registration, accounts and passkeys carry over. Run `hailctl backup configure`
again: bucket settings are not part of a backup.

## Not yet included

- Running behind an existing reverse proxy or tunnel. `hailctl` requires direct
  public ports 80 and 443; see the [standalone guide](../server/deploy/standalone/README.md)
  for manual deployments.

## Development

```bash
cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked
```

`HAILCTL_DEV_SKIP_PUBLIC_CHECKS=1` makes **debug** builds skip the public DNS and HTTPS
checks and accept a plain-HTTP bucket endpoint, so the flows can be exercised against a
local Docker daemon and S3 server. Release builds ignore it.

Release binaries are static (`*-unknown-linux-musl`) and built by
`.github/workflows/release-provider.yml`. The crate version must equal the provider
release version in `apps/server/package.json`. `install.sh` is tested end to end by
`apps/server/test/provider-installer.test.ts`.
