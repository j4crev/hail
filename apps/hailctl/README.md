# hailctl

Installs and operates a Hail provider from a signed provider release.

```bash
curl -fsSL https://get.racrproto.com | sh
```

To install a specific release instead of the newest, name it:
`curl -fsSL https://get.racrproto.com/provider-v0.3.0 | sh` (0.3.0 or later; the 0.2.0
installer cannot start a provider).

## Requirements

- Ubuntu 26.04 LTS or Debian 13, on amd64 or arm64. Root (`sudo`) is needed once, to
  prepare the server; see [who runs what](#who-runs-what).
- At least 2 GiB of memory and 10 GiB of free disk.
- One way for HTTPS to reach the server:
  - **Direct:** ports 80 and 443 free and reachable from the internet. Caddy obtains
    certificates automatically.
  - **Cloudflare Tunnel:** no open ports. A `cloudflared` container connects out to
    Cloudflare, which terminates HTTPS. You need a Cloudflare account with both
    hostnames' zones, and a tunnel created in Zero Trust (Networks > Tunnels) whose
    token you give to `hailctl`. Route both hostnames to `http://caddy:8080` in the
    tunnel's public hostnames. The token is kept only in `/opt/hail-provider/.env`.
- Two DNS names for this server: an **API hostname** (such as `svr.example.com`) and
  a **web hostname**, which is also the address domain (such as `example.com`, for
  addresses like `alice@example.com`).
- An email address you can read during the install.

## Who runs what

Root is used once, by the installer, and never again:

| As root (the installer, once) | As the unprivileged `hail` user (everything else) |
| --- | --- |
| Installs Docker Engine with rootless support, `uidmap`, `dbus-user-session` and `passt` from Docker's and the distribution's apt repositories | Downloads and verifies releases, writes the configuration |
| Creates the `hail` user and its subordinate IDs, lets its systemd manager run at boot (lingering) | Runs the provider in its own **rootless Docker** daemon |
| Lets unprivileged processes bind ports 80 and 443 (`net.ipv4.ip_unprivileged_port_start=80`) | Registers with the monitor, creates accounts, backs up, upgrades, rolls back |
| Disables the system Docker daemon if it installed it | Runs the daily backup as a systemd user timer |
| Installs `hailctl` for `hail` and a root-owned `/usr/local/bin/hailctl` shim | Updates its own `hailctl` on upgrade |

`hail` cannot become root. It has no sudo rights, and it is not in the `docker` group,
whose members can take over the host. Its Docker daemon runs in a user namespace, so
root inside a container is an unprivileged user outside it. The daemon uses pasta
networking, so the provider still sees each client's real address.

Run `hailctl` either way:

- `sudo hailctl status` and so on: the root-owned shim switches to `hail` before it
  runs `hail`'s binary, so that binary never runs as root.
- As `hail`, for example over SSH. Add a key to `/home/hail/.ssh/authorized_keys` to
  give an operator or agent full control of the provider without any root access.

Files you pass to `sudo hailctl` (an answers file, a backup) must be readable by `hail`,
for example in `/opt/hail-provider`. The installer copies the ones it is given.

## What `hailctl install` does

1. Checks the server, then prepares it as root (above).
2. Asks for the two hostnames, a provider ID and your operator email.
3. Asks how HTTPS reaches the server (direct or Cloudflare Tunnel), shows the DNS
   records to create (direct: A/AAAA for both hostnames; tunnel: the tunnel's public
   hostnames; always the `_hail-provider` TXT record) and waits until public DNS has
   them.
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
install, run the installer (or `sudo hailctl install`) again; it resumes where it
stopped and never regenerates secrets. Running the installer again also repairs the
root setup and installs its `hailctl` version.

## Unattended installs

Pass an answers file:

```toml
api_host = "svr.example.com"
web_host = "example.com"
provider_id = "example"
operator_email = "ops@example.com"
# Write secrets that must be backed up to /opt/hail-provider/BACK-UP-THESE-SECRETS.txt
# (readable only by hail and root) instead of showing them. Copy them offline, then
# delete that file.
secrets_to_file = true
# Optional: no open ports, through a Cloudflare Tunnel (default "direct").
# ingress = "cloudflare-tunnel"
# tunnel_token = "eyJ..."   # moved into .env, never stored in hailctl.json
# Optional: the inbound email bridge, for aliases on a domain of their own.
# email_bridge_domain = "example.email"
```

```bash
curl -fsSL https://get.racrproto.com | sh -s -- --answers answers.toml
```

The emailed operator code is still required: `hailctl` reads it from
`HAILCTL_OPERATOR_CODE` or from one line on standard input.

## Email bridge

The [email bridge](../../spec/email-bridge.md) lets users create email aliases whose mail
reaches them as Hail messages from the provider's `email@` account. Turn it on with an
alias domain of its own (`email_bridge_domain`, or the interactive question). `hailctl`
then:

- sets the bridge's settings in `.env`, including a fresh intake token and converter
  password;
- creates the converter's database role, which can touch only the intake queue, and
  starts the converter (Compose profile `email-bridge`);
- creates the `email@` service account with a Sender Profile offering the `email`
  category, which users grant to receive bridged mail;
- recreates the converter's roles after a restore into a new server, and refreshes its
  grants after upgrades.

Mail reaches the provider through an ingress adapter that you deploy. With Cloudflare,
put the alias domain on Cloudflare and deploy the
[email Worker](../server/deploy/cloudflare-email-worker/README.md) with
`PROVIDER_ORIGIN`, `ALIAS_DOMAIN` and the intake token from `.env`. Then set the alias
domain's Email Routing catch-all to the Worker. `hailctl` prints these steps when it
finishes.

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
runs `hailctl` (as root, from a private temporary directory) only if its SHA-256
matches the signed manifest. That verified binary is what the root setup installs for
`hail`. `hailctl` embeds
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
settings, credentials included, in `/opt/hail-provider/backup-remote.toml` (readable
only by `hail`). From then on every backup is uploaded and read back. A scheduled
backup that cannot be uploaded fails, so the timer shows it (`systemctl --user status
hail-provider-backup` as `hail`). `hailctl` never deletes from the bucket, so set a lifecycle
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
curl -fsSL https://get.racrproto.com | sh -s -- --restore example-20261112T030000Z-scheduled.tar.age
```

`hailctl` asks for `KEY_ENCRYPTION_KEY` (or reads `HAILCTL_KEY_ENCRYPTION_KEY`), and
restores the configuration and data. Point both hostnames' DNS at the new server.
`hailctl` then waits for DNS, starts the backup's release, and schedules backups. The
monitor registration, accounts and passkeys carry over. Run `hailctl backup configure`
again: bucket settings are not part of a backup.

## Not yet included

- Running behind your own reverse proxy, or another tunnel service. `hailctl` supports
  direct ports 80/443 and Cloudflare Tunnel; see the
  [standalone guide](../server/deploy/standalone/README.md) for manual deployments.
- Changing the ingress of an installed provider.

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
