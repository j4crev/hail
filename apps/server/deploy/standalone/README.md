# Run your own Hail provider

The provider is a standalone HTTP service. It does not contain or require the
reference web client. Native apps and alternative clients use its account API;
peer providers use its federation endpoints. The optional reference web client
is published as a separate image. Keep the same reviewed revision for both until
an explicit cross-version compatibility policy is established.

Hail is pre-launch. This guide is for a **fresh installation**, not a PostgreSQL
upgrade or a replacement for an existing deployment's volumes and configuration.
It is the provider deployment and first-administrator runbook. The PLC monitor is
a separate service; use the monitor guide only if you choose to operate that
service yourself.

## In this guide

- [Choose published images](#choose-the-provider-image)
- [Configure the host, secrets, and DNS](#1-configure-the-server)
- [Start and verify the provider](#2-start-without-a-web-client)
- [Configure signup and monitor integration](#3-account-bootstrap-and-client-apis)
- [Add the optional web client](#4-optionally-add-the-reference-web-client)
- [Create the first administrator](#first-administrator)
- [Operate and upgrade](#operate-and-upgrade)

## Choose the provider image

The `HAIL_PROVIDER_IMAGE` value must be an immutable digest from a successful
provider image publication for the reviewed source commit. In the repository
that will publish the image, open **Actions → Publish provider and web-client
images**, run it on `main`, and wait for success. The workflow requires successful
push CI for that exact commit and publishes a `provider-release` artifact. Download
that artifact and copy its provider digest into `.env`. The optional web-client
digest is used in the next section if you choose to run the reference client.

For a fork, the same workflow publishes to that repository's image namespace;
make sure the provider host has pull access to the selected package. Record the
commit and digest together so later upgrades can be reviewed and reproduced. Do
not select an image by a mutable tag alone.

## 1. Configure the server

Use a Linux host with Docker Engine and the Compose plugin, a public domain,
and a stable public IP address. Use a provider hostname such as `svr.example.com`;
if adding the GUI, also point a distinct browser hostname such as `example.com`
at this host. Point their A/AAAA records at the host.
Allow inbound TCP 80/443 (UDP 443 is optional for HTTP/3); restrict SSH to your
administration network. The supplied Caddy terminates HTTPS and obtains
certificates automatically. The database and provider have no host-published
ports. Do not expose PostgreSQL or the provider's HTTP port directly.

Install Git, OpenSSL, Docker Engine and its Compose plugin using your Linux
distribution's supported installation procedure. Verify `docker version` and
`docker compose version` through your existing privileged administration access.
Check out the exact source commit recorded in the publication artifact, so the
Compose files and images describe the same release.

From that reviewed repository checkout:

```bash
cd apps/server/deploy/standalone
umask 077
cp .env.example .env
chmod 600 .env
```

Edit `.env`: select your domain, provider/operator identifiers, a verified
`HAIL_PROVIDER_IMAGE=image@sha256:...` from the publication artifact, and two
independent secrets for `DB_PASSWORD` and `KEY_ENCRYPTION_KEY`. Generate each with:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Use the generated base64url password as-is (the database connection embeds it in
a URL). Keep the encryption key with encrypted backups; losing it loses access to
provider-held operational keys. No Haili private endpoint or token is required.

### DNS discovery for your provider

Set `PROVIDER_DOMAIN=svr.example.com` for API/federation/media and
`NATIVE_ADDRESS_DOMAIN=example.com` for addresses such as `admin@example.com`.
For the optional GUI, set `WEB_CLIENT_DOMAIN=example.com`. The GUI and native
address domain may match; the provider and GUI origins must differ.

Publish one TXT record at your **address domain**, substituting your values:

```dns
_hail-provider.example.com. TXT "v=hail1; provider=svr.example.com"
```

Custom address domains point their `_hail-provider` record at this provider too;
registration also requires the issued `_hail-domain-verify` challenge. These
records do not configure SMTP email. Allow outbound DNS and HTTPS for discovery,
PLC reads and federation. Public identities use the canonical `plc.directory`;
that is a protocol dependency, not a Haili deployment address.

## 2. Start without a web client

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --wait
```

Check `https://YOUR_DOMAIN/health/ready` from another network. `/` returns 404
on the provider hostname, including when a web client is attached. That is expected;
the optional GUI has its own hostname.
Migrations run at startup. PostgreSQL 18 uses the persistent `provider_db` volume.
Do not remove that volume to upgrade an application.

Caddy overwrites `X-Hail-Trusted-Client-IP` with the direct peer address. This
profile assumes direct public ingress. If you put a proxy or tunnel in front,
adapt Caddy and the trusted client-address path for that proxy; do not copy the
Haili-specific `deploy/public` configuration, which trusts only its host tunnel.

## 3. Account bootstrap and client APIs

Server-only does not mean dependency-free signup. Current invitation admission
uses the alpha signup signing configuration, including email and automatic monitor
services, even for CLI signup. Arrange those services, then set:

```dotenv
PUBLIC_SELF_SERVICE_ONBOARDING=true
SIGNUP_EMAIL_ORIGIN=https://alerts.monitor.example.com
SIGNUP_EMAIL_TOKEN=<independent 32-byte base64url secret>
SIGNUP_MONITOR_API_ORIGIN=https://enroll.monitor.example.com
SIGNUP_MONITOR_TOKEN=<credential issued by monitor provider registration>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
PUBLIC_ALPHA_SIGNUP=true
ALPHA_SIGNUP_INVITE_KEY=<independent 32-byte base64url secret>
ALPHA_SIGNUP_MONITOR_ORIGIN=https://monitor.example.com
```

See the [monitor deployment guide](../../../plc-monitor/deploy/public/README.md) if you operate that service.
For a shared monitor, follow its [self-service provider registration](../../../plc-monitor/deploy/public/provider-registration.md)
to obtain your own credential and monitor key/origins. Registration verifies control
of your provider API and alert-receiver origins; user security-email verification
still occurs during signup. Do not generate an unrelated token and expect the monitor
to accept it, or reuse another provider's credential.
Then create the [first administrator](#first-administrator) below.
No reference-client process is needed for provider CLI commands or bearer API use;
the browser passkey and dashboard steps require adding the web client.
Recreate the provider after changing environment settings. Test startup with the
final signup configuration as well as the basic server-only configuration; signup
and passkey validation runs before the provider starts accepting requests.

Alternative clients should start with the
[account API contract](../../../cli/docs/cli-contract.md),
[CLI workflows](../../../cli/docs/cli-workflows.md), and
[protocol specifications](../../../../spec). Shared TypeScript response contracts
live in `@racrproto/client-support/provider-contracts`; native apps consume the
same HTTP representations without depending on TypeScript packages. The reference
client is an example consumer, not a required runtime dependency. The API remains
pre-launch; this packaging split does not promise version-stable contracts.

## 4. Optionally add the reference web client

Set `HAIL_WEB_CLIENT_IMAGE` to the **separate client digest** in the same release
artifact. Set a distinct `WEB_CLIENT_DOMAIN`, configure its DNS, then run:

```bash
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml pull
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml up -d --wait
```

The overlay selects `Caddyfile.web-client`: API/federation/media requests on
`PROVIDER_DOMAIN` go to the provider, and `WEB_CLIENT_DOMAIN` goes to the GUI.
It configures passkeys for the browser hostname and keeps the provider's public
API origin separate. No GUI pages are served on the provider origin.
The GUI uses private `http://provider:3000` transport. Neither container is
exposed directly. The browser's `/api/*` bridge preserves Origin and scoped
Authorization headers, forwards the host-only session, and returns JSON only.
Uploaded avatars/attachments use short-lived provider capabilities; the browser
session cookie is not shared with the provider hostname or sibling subdomains.

Visit `https://WEB_CLIENT_DOMAIN/` for the app; check provider readiness at
`https://PROVIDER_DOMAIN/health/ready`. A fresh account's passkey recovery URL
must point to the browser hostname, while its CLI credential's `provider` must
point to the API hostname. Keep API redirects disabled in native clients.

For a different web client, route its pages at its own origin and implement its
authentication and Origin checks. Do not expose uploaded media through the app
origin or allow the media origin to read authenticated JSON responses via CORS.
Native applications use the account-credential workflows without browser cookies.

### Branding

The reference client defaults to **Hail** and the existing simple `h` mark.
Override at runtime, without rebuilding:

```dotenv
HAIL_WEB_CLIENT_NAME=Example Mail
HAIL_WEB_CLIENT_LOGO_PATH=/brand/logo.svg
HAIL_WEB_CLIENT_FAVICON_PATH=/brand/favicon.png
```

Make the files available at those same-origin paths. For the reference image,
create a host `brand` directory and add a local Compose overlay:

```yaml
services:
  web-client:
    volumes:
      - ./brand:/workspace/hail/apps/client/build/client/brand:ro
```

Append this overlay to every Compose command. Assets must be readable by the
container's unprivileged user. Remote image URLs are intentionally excluded by
the client CSP. Names, accessible labels and page titles use the configured name;
protocol references say RACR. Recreate the client after changing settings.


## First administrator

`admin@` is a [provider service account](../../../../spec/provider-service-accounts.md):
an address that belongs to your server, whose keys the server holds. You create it
on the provider host. No vault, recovery file, laptop CLI or monitor handoff is
involved, and it cannot be transferred to another provider.

Run these commands on the provider host, from this directory, after the provider
and web client are healthy and reachable at their public hostnames. Creating the
account registers a public identity and checks its address through public DNS
and HTTPS, so DNS must already resolve. `service` is a shorthand for the Compose
command you started the stack with:

```bash
service() { docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml \
  exec provider bun src/cli/service-account.ts "$@"; }
```

### 1. Create the provider recovery key

```bash
service recovery-key generate
```

This prints a private key **once**. Store it offline (a password manager or
printed copy kept away from the server). The server keeps only its public half,
which is listed first in the identity of every service account. If the server or
its `KEY_ENCRYPTION_KEY` is ever lost or compromised, this key is how those
identities are recovered. It cannot be changed later. If you generate keys
elsewhere, record the public key instead with `service recovery-key set did:key:z...`.

### 2. Create `admin@`

```bash
service create admin
```

**Expected:** JSON with `"address": "admin@<your address domain>"` and
`"active": true`. If it stops part-way (for example a DNS or PLC timeout), run the
same command again; it resumes the same account rather than creating another.

### 3. Enroll your passkey

```bash
service passkey-link admin
```

Open the printed `url` in your browser within ten minutes and create a passkey.
The link works once. Enrolling it makes `admin@` the provider operator, so
`/admin` on your browser hostname now shows the dashboard. Issue another link the
same way to add a passkey on another device, or after losing one.

The `/admin` dashboard needs the signup configuration from
[section 3](#3-account-bootstrap-and-client-apis). Passkey login needs the web client.

### Email bridge sender

When the email bridge is enabled, create its sender the same way and give it a
Sender Profile with the bridge category. Save the profile as `email-profile.json`:

```json
{"display_name":"Email","categories":[{"id":"email","label":"Email"}]}
```

```bash
service create email
docker compose --env-file .env -f compose.yaml -f compose.web-client.yaml \
  exec -T provider sh -c 'cat > /tmp/profile.json && bun src/cli/create-profile.ts "$0" /tmp/profile.json' \
  "email@<your address domain>" < email-profile.json
```

Set `EMAIL_BRIDGE_SENDER` to that address. Other reserved names (`abuse`,
`security`, `support`, `ops`, `alerts`) can be created from **Service accounts**
on `/admin` when you need them.

### Everyday use

Sign in on your browser hostname, then open `/admin` or
**Provider administration** in the sidebar. Enter an email address to send an
invitation, or leave it blank to create a private link. Invitations last seven
days and can be used once. Anyone holding the link can use it; the delivery email
is not an enforced identity restriction.

History distinguishes email-service acceptance from signup started or completed.
An unconfirmed email send is not proof of failure: check with the recipient
before issuing another invitation.

To remove operator access from an account, run
`docker compose ... exec provider bun src/cli/provider-operator.ts revoke <address>`.
This does not invalidate invitations already issued.

| Symptom | What to check |
| --- | --- |
| `Set the provider recovery key before creating service accounts` | Complete step 1 first |
| `create admin` stops with a DNS, PLC or verification error | Check DNS and public HTTPS for both hostnames, then rerun the same command |
| `Create the active admin service account first` | Run step 2 until it reports `"active": true` |
| The passkey link says it expired or was used | Run step 3 again for a fresh link |
| Login works but `/admin` returns 403 | Sign in with the passkey enrolled through the step-3 link |

## Operate and upgrade


Back up PostgreSQL, `.env`, image digests and all overlays. Encrypt backups off-host
and rehearse restoration. Publish images through GitHub Actions; do not build on
a live provider. Pin digests, review schema compatibility, stop incompatible old
writers, and use the same Compose files for every update. Restoring an application
image does not roll back database migrations or erase newly accepted writes.

The scripts under `deploy/public` are Haili-specific operations, not a generic
installer or required provider code. Use your own service supervision and reviewed
backup/restore procedures. Keep monitoring available outside the provider host.

## Replacing a disposable pre-launch provider

A fresh install creates new accounts, DIDs, credentials, relationships, and
passkeys. It does not move old identities or import their state. Keep old recovery
material and backups; public PLC history is permanent. An old vault bound to a DID
is not an unbound vault for a new signup, even if the new account uses the same
human-readable address. Clear stale browser session/signup state for this app and
use a new private CLI state directory.

Before reusing a host:

1. Inventory the active Compose project, all overlays, database/storage volumes,
   image digests, secrets, backup jobs, ingress and monitoring. Record which
   accounts will be retired. Stop application writers before the final backup.
2. Make an encrypted off-host archive of the database, configuration and recovery
   material, and prove the database dump restores on a disposable instance of the
   same PostgreSQL major. Preserve the original volumes and encryption keys.
3. Select fresh database storage explicitly. The supplied Compose project is named
   `hail-provider`; a previous installation with that name will reuse its volumes.
   For an independent replacement, use a new `--project-name` on **every** Compose
   command and verify its resolved volume names before startup. Never use
   `down --volumes` to make an installation appear fresh.
4. Decide which existing service owns ports 80/443 and the public hostnames before
   starting Caddy. Follow this guide's direct HTTPS path, or adapt ingress for your
   existing proxy using the requirements below. Keep the old application stopped
   so it cannot accept writes while the new service owns those names.
5. Follow the installation and first-administrator steps above. Adapt existing
   backup and operations tooling to the selected project, service names and full
   overlay list before enabling routine jobs. Verify a new off-host backup and
   restore before retiring the archived deployment.

Keep old data archived until the new install and backups are verified. Releasing
an address at a new DID does not notify old contacts or replace their saved
relationships. Application image rollback cannot restore the retired accounts;
restoring the previous installation is a separate data/configuration recovery.

### Optional reverse proxy or tunnel

A proxy or tunnel is an alternative ingress deployment, not a signup dependency.
Publish both provider and browser hostnames and preserve the original Host header
when routing to Caddy. Bind its HTTP listener to loopback when the connector runs
on the same host; restrict it to the proxy network otherwise. Configure TLS at the
public edge and secure any non-loopback upstream transport.

Trust client-address headers only from that explicitly configured proxy. Caddy
must replace `X-Hail-Trusted-Client-IP` before forwarding requests; direct callers
must not be able to impersonate the proxy. Disable caching and browser challenges
for API/federation/authentication traffic. Verify both hostnames from outside the
server and confirm uploaded media is served only on the provider origin.

Provider-specific tunnel installation, DNS records and firewall rules belong in
that operator's site configuration. The [Haili operations notes](../../../../agents/haili-operations.md)
record that deployment's Cloudflare setup and installed wrapper constraints;
those are not prerequisites for an independent provider.

A reset of the dedicated test PLC monitor is a separate operation. Follow
[archive and restart monitoring](../../../plc-monitor/deploy/public/reset-test-monitor.md)
before enrolling the new identities. Set its enrollment-provider pin to the new
API origin; preserve its key unless deliberately rotating that key everywhere it
is trusted. The provider and monitor resets do not clear the external email
receiver's state.

### Provider transfers

Accounts can move between providers that use separate API and address domains,
such as `svr.example.com` and `example.com`. A source provider confirms that a
destination's address domain belongs to its API host by reading the
`_hail-provider` record from [DNS discovery](#dns-discovery-for-your-provider), so
keep that record published. Clients learn the address domain from the
destination's `/api/v1/capabilities` (`addressDomain`). Transfer requests between
providers use the API hostname. Addresses on hosted custom domains cannot be
transferred yet.

Managed-account transfer is off by default. To enable it, set
`PUBLIC_MANAGED_TRANSFER=true` together with `PLC_MANAGED_MONITOR_ORIGIN` and
`PLC_MANAGED_MONITOR_PUBLIC_KEY` for an independent monitor on a different
hostname from this provider. Those declarations belong to managed transfer, not
the separate `SIGNUP_MONITOR_*` settings.
