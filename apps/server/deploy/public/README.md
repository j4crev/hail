# Haili site deployment (Cloudflare Tunnel)

For a new independent deployment, start with the
[standalone provider guide](../standalone/README.md). This directory retains
Haili-specific scripts and paths so installed wrappers, backups and overlays
continue to refer to the same deployment location. Do not install its scripts
unchanged on another host. The stack contains the TypeScript provider, browser GUI,
PostgreSQL and a loopback-only Caddy edge behind a host Cloudflare Tunnel.
Hail is pre-launch: select a reviewed repository revision and plan coordinated
application/schema upgrades. The [protocol specifications](../../../../spec) define
federation; this guide configures the reference implementation.

## 1. Prepare the host and domain

You need a Linux host with Docker Engine and Docker Compose (2.40.3 or later for
the override example below), Git, OpenSSL, a domain you control in Cloudflare,
a host-installed cloudflared connector, and privileged console recovery access.
Use your own domain throughout; the checked-in example defaults to `haili.app`.
Do not point an independent provider at Haili's private tokens or deployment scripts.

Clone the monorepo and initialize its pinned PLC dependency:

```bash
git clone --recurse-submodules https://github.com/j4crev/hail.git
cd hail
# Select your reviewed release before building.
git submodule update --init --recursive
cd apps/server/deploy/public
umask 077
cp .env.example .env
chmod 600 .env
```

Use a host name distinct from the public provider domain. Some VPS images map their
host name to loopback in `/etc/hosts`. Check `getent ahosts <your-provider-domain>`
from the host and later from the containers: public activation must resolve the
public endpoint. Correct persistent cloud-init aliases as well as `/etc/hosts`.

## 2. Configure identity, secrets and feature gates

### DNS discovery for your provider

Publish this TXT record for your native address domain, substituting your domain:

```dns
_hail-provider.haili.app. TXT "v=hail1; provider=svr.haili.app"
```

Use one record, the exact lowercase format above, and a public hostname without
`https://`, a port, or a path. A self-reference is intentional: discovery does
not recurse. Remote providers check this record when discovering your users.
Your own provider skips the TXT lookup for its exact configured native domain
and goes directly to that domain's HTTPS WebFinger endpoint. All other domains,
including custom domains hosted on your server and native-domain subdomains,
still use DNS discovery. Custom-domain registration always checks DNS explicitly.
Absent records retain domain-hosted HTTPS WebFinger; malformed records and DNS
failures stop discovery. Your provider must still serve WebFinger and signed
bindings at its HTTPS origin. This discovers an address's DID; later account
activities and delivery use that DID's PLC-resolved Hail service and permissions.

Allow outbound DNS to your configured recursive resolver and HTTPS to remote
providers. Prefer a DNSSEC-validating resolver. Hail currently accepts unsigned
DNS, so the resolver is part of the discovery trust boundary. Recursive caching
honors DNS TTLs; no application cache or scheduled domain checks are used.

For a custom domain hosted by this provider, the same record names your provider
instead of the custom domain, for example
`_hail-provider.example.com TXT "v=hail1; provider=svr.haili.app"`. Domain registration
also requires the provider-issued `_hail-domain-verify` challenge. After verification,
Settings → Custom domains can authorize a separate signup for an exact custom
address without an additional invitation, even in invite-only mode. General
native-address signup still follows the provider’s registration policy. With public registration enabled,
new publishers can choose **Use a custom domain…** beside the username at `/signup`,
prove both TXT records in the added verification step, and
create their custom account directly without a provider-native account. The new
account owns the domain administration record. Keep both TXT records until account
setup starts; afterward remove only `_hail-domain-verify`, keeping `_hail-provider`.
The DNS setup lasts 24 hours, with 15 minutes to begin signup after verification.
If registration closes before admission, standalone signup stops; already-admitted
setups can continue through their existing recovery and passkey flow. Upgrade resolvers
before advertising DNS-only addresses: old WebFinger-only clients cannot discover
them. Neither record changes website hosting or SMTP email routing.

### Provider configuration

Edit the private `.env`:

| Setting | Value |
| --- | --- |
| `PROVIDER_DOMAIN` | Provider API/media hostname, e.g. `svr.haili.app` |
| `WEB_CLIENT_DOMAIN` | Distinct browser hostname, e.g. `haili.app`; also the existing passkey RP ID |
| `NATIVE_ADDRESS_DOMAIN` | Native account domain, e.g. `haili.app`; independent of API hostname |
| `PROVIDER_ID` | A stable local identifier for this provider |
| `PLC_PROVIDER_OPERATORS` | JSON array naming the actual operator, e.g. `["example-operator"]` |
| `DB_PASSWORD` | Independent random database secret |
| `KEY_ENCRYPTION_KEY` | Independent 32-byte base64url key for retained operational keys |
| `PASSKEY_AUTH` | `true`; RP ID/origin derive from `WEB_CLIENT_DOMAIN` |
| `PASSKEY_SESSION_IDLE_SECONDS` | `604800` (7 days); successful authenticated requests reset this deadline |
| `PASSKEY_SESSION_ABSOLUTE_SECONDS` | `2592000` (30 days); database and cookie lifetime for new logins |
| `CONNECTION_PREVIEW` | Explicit `true` or `false`; the supplied profile defaults to `true` |
| `PUBLIC_SELF_SERVICE_ONBOARDING` | Initially `false`; enable after the monitor/backup ceremony is ready |
| `PUBLIC_ALPHA_SIGNUP` | Initially `false`; browser signup needs email and automatic monitoring |
| `PUBLIC_MANAGED_TRANSFER` | Initially `false`; transfer requires separate operational readiness |

Generate each secret separately; do not reuse one across roles:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

The checked-in `.env.example` contains placeholders, not production secrets.
The real `.env` is ignored by Git and should have mode `600`. On the Haili host,
`provider-ops.sh` reads `/opt/hail/apps/server/deploy/public/.env` explicitly
with Docker Compose's `--env-file`. Do not commit that file or rendered Compose
output, which can contain resolved secrets.

The public Compose defaults are 7 days idle and 30 days absolute. Explicit values
in the private `.env` override those defaults. Recreate the provider container
using the deployment's Compose files after changing environment values; a plain
container restart does not reload them. New absolute lifetimes apply at the next
login; existing sessions retain their original absolute expiry.

Keep `.env` and recovery material outside version control. Changing the encryption
key without a key migration can make stored operational keys unreadable. Changing
the passkey RP ID invalidates existing provider-local passkeys.

The base Compose file hardcodes `PUBLIC_CUSTODY_TRANSITIONS: "true"` for Haili.
A `.env` variable does not override that literal. New operators can disable it in
a local Compose overlay until custody/recovery procedures are ready.

## 3. Select persistent database configuration

The checked-in base Compose file pins PostgreSQL 14.24. Existing Haili hosts use
an independently retained PostgreSQL 18 overlay. A fresh installation can use the
following explicit 18.6 baseline with an empty volume; review the image pin for
your deployment. This example is **not** an upgrade procedure for an existing database.

Create `compose.local.yaml` beside the base file:

```yaml
services:
  db:
    image: postgres:18.6-alpine
    volumes: !override
      - provider_db18:/var/lib/postgresql
  provider:
    environment:
      PUBLIC_CUSTODY_TRANSITIONS: "false"
volumes:
  provider_db18:
```

Use the same ordered files for every Compose command, backup and application
rollback. Keep the overlay with your deployment configuration and encrypted backup.
Never mount a PostgreSQL 14 data directory into 18, select an old volume after new
writes, or run `down -v` as an upgrade/recovery step. Existing databases need a
separately rehearsed dump/restore migration and preservation proof.

## 4. Configure HTTPS ingress

Create Cloudflare Tunnel ingress entries for both provider and web-client hostnames and run its connector as a
host service with a protected tunnel credential. Publish the hostname through the
tunnel's proxied CNAME, routing to **HTTP `127.0.0.1:8080`** with your provider
and browser hostnames preserved as the HTTP Host Header on their respective routes.
Do not force both routes to use the provider hostname. Remove obsolete direct-origin A/AAAA records.

Configure HTTPS enforcement and cache bypass for dynamic application traffic.
Disable browser-only challenges for `/api`, `/hail`, `/.well-known`, `/health`
and their slash-delimited subpaths. Federation clients cannot complete interactive
Access or browser challenges. Keep managed WAF/DDoS protection; Free-plan Bot Fight
Mode cannot be selectively bypassed for these API paths.

Browser Integrity Check is a separate Cloudflare setting and can return error
1010 to otherwise valid CLI/federation clients. In the `haili.app` website dashboard,
use **Rules → Overview → Create rule → Configuration Rule**, set **Browser
Integrity Check: Off**, and match:

```text
(http.host eq "svr.haili.app") or
(http.host eq "haili.app" and (
  http.request.uri.path in {"/api" "/hail" "/.well-known" "/health"} or
  starts_with(http.request.uri.path, "/api/") or
  starts_with(http.request.uri.path, "/hail/") or
  starts_with(http.request.uri.path, "/.well-known/") or
  starts_with(http.request.uri.path, "/health/")
))
```

Keep unrelated WAF protections enabled. Preserve exceptions for discovery and
health on the native/browser domain when adding the separate provider hostname.
Verify these paths using a non-browser client signature as well as the browser;
HTTP 403 with `error code: 1010` is an edge-policy failure, not provider readiness.

Only the host connector may reach the origin listener. Caddy trusts
`CF-Connecting-IP` there and overwrites `X-Hail-Trusted-Client-IP`; never expose
8080 publicly or forward caller-supplied trusted-client headers. Preserve actual
IPv6 addresses: do not enable Remove visitor IP headers or Pseudo IPv4 transforms.

Use key-only administration over your private access network, retain console
recovery, and restrict host/hosting firewalls for both IP families after testing
private access and outbound connectivity. The database and provider containers
must remain private. Test Docker forwarding rules as well as the host firewall.

## 5. Pull, start and verify a fresh installation

These commands are for initial setup, not updates to the managed production host.
For ongoing Haili releases, use the
[routine rollout](../../../../agents/release-process.md#routine-production-rollout--operators-and-agents).

Run from `apps/server/deploy/public`:

```bash
docker compose --env-file .env -f compose.yaml -f compose.local.yaml config --quiet
# Set HAIL_PROVIDER_IMAGE and HAIL_WEB_CLIENT_IMAGE to their respective CI digests first.
docker compose --env-file .env -f compose.yaml -f compose.local.yaml pull gui provider
docker compose --env-file .env -f compose.yaml -f compose.local.yaml up -d --no-build --wait db gui provider caddy
docker compose --env-file .env -f compose.yaml -f compose.local.yaml ps
```

Provider and web client use separate images from the same reviewed revision. The provider applies pending
migrations before listening. Inspect service logs if health checks fail. Container
health alone does not prove public DNS, TLS, discovery or monitoring work.

From another network:

```bash
curl --fail --silent --show-error https://your-provider.example/health/ready
curl --fail --silent --show-error https://your-browser.example/
```

Verify the tunnel connector is ready, requests are not cached/challenged, and direct
public database/provider/origin ports are inaccessible. After creating an account,
verify WebFinger, its signed Address Binding and a grant-authorized exchange with
a compatible peer. A generic envelope HTTP receipt is not proof of delivery.

## 6. Arrange monitoring and signup admission

Before publishing an identity, arrange a reviewed monitor and external alert path.
Follow the [monitor deployment guide](../../../plc-monitor/deploy/public/README.md)
and [email receiver guide](../../../plc-monitor/deploy/cloudflare-alert-worker/README.md).
Strict public CLI onboarding requires the independent-monitor evidence specified by
the protocol. Same-operator monitoring belongs to the explicitly reduced-assurance
browser alpha profile; separate hosting alone does not make it independent.

Registration defaults to `invite` for both CLI and browser. The current runtime
loads the invitation verification key from enabled alpha signup configuration;
merely enabling CLI onboarding or reserving `admin` does not bypass admission.
Configure email and automatic monitor enrollment before bootstrapping an invited
administrator, even though that administrator uses the manual strict-public monitor
ceremony. Deploy the email receiver first, then the monitor API. Set:

```dotenv
PUBLIC_SELF_SERVICE_ONBOARDING=true
SIGNUP_EMAIL_ORIGIN=https://alerts.your-monitor.example
SIGNUP_EMAIL_TOKEN=<independent email-service secret>
SIGNUP_MONITOR_API_ORIGIN=https://enroll.your-monitor.example
SIGNUP_MONITOR_TOKEN=<monitor enrollment service secret>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
PUBLIC_ALPHA_SIGNUP=true
ALPHA_SIGNUP_INVITE_KEY=<independent canonical 32-byte base64url signing key>
ALPHA_SIGNUP_MONITOR_ORIGIN=https://your-monitor.example
```

The monitor identity origin must match signed attestations; it may differ from the
API hostname. The web origin registered with the shared receiver must match the browser/passkey origin.
The [monitor guide](../../../plc-monitor/deploy/public/README.md#automatic-reduced-assurance-alpha-enrollment)
defines matching settings and the authenticated email-binding contract. Recreate
provider/GUI using the same Compose files after environment changes; a plain restart
does not reload them. Keep registration invitation-only during bootstrap.

## 7. Create the administrator and invite users

Follow [first administrator ceremony](../standalone/README.md#first-administrator-vault-to-dashboard):

1. Generate and independently back up the owner's vault on their computer.
2. Authorize its public recovery key for the reserved administrator address.
3. Mint a private signup invitation from the provider console and transfer it to the owner.
4. Start CLI onboarding, enroll the exact public state with the monitor, and retrieve its attestation.
5. Complete onboarding, enroll/test a passkey, and grant explicit operator permission.

Reserved names (`admin`, `ops`, `alerts`, `abuse`, `security`, `support`, `email`) are not
accounts and confer no privilege automatically. They remain reserved on custom
domains too. The reserved native-domain administrator uses CLI signup;
the browser address picker intentionally excludes reserved names.

After first login, `/admin` can issue private signup links or send email invitations
and can switch public registration on/off with recent passkey verification.
Invitations are seven-day, single-use admission capabilities; email-service acceptance
is not inbox delivery. CLI and browser share the admission ledger. Public mode removes
only the invitation requirement, not recovery, monitoring or reserved-name restrictions.

The browser wizard verifies **one saved DID-bound recovery package** before explicit
publication, verifies email, waits for monitored activation, and requires fresh
passkey sign-in before retiring setup authority. No full-access signup credential
is issued. See [signup behavior](../../../client/README.md#invited-signup) and
[trust/recovery boundaries](../../../../docs/public-authentication.md).

The signup API retains exact intent under a setup bearer. `POST /api/v1/signup`
creates the provisional ceremony; `GET /:id` reads progress; `POST /:id/verify-backup`
records the saved-package digest commitment; `POST /:id/advance` resumes the exact
operation; `POST /:id/complete` requires the fresh passkey session. These paths are
under `/api/v1/signup`; POSTs require the expected Origin and responses are no-store.
Retries cannot change keys, address or token hashes or revive retired setup authority.

Verify an invited browser signup, alert, passkey login and explicit message exchange
before expanding admission. Setup lasts 24 hours and enrollment tokens ten minutes.
Keep original package/state after interruption. Switching registration to invite
preserves admitted continuations; disabling the signup endpoint affects continuation
as well. Preserve retained ceremonies and use compatible code for rollback.

## 8. Operate and upgrade

Maintain encrypted off-host backups of the database, `.env` (including key encryption
material), selected image/revision and Compose overlays. Keep the decryption key off
the provider and test restoration into an isolated instance on the recorded PostgreSQL
major. Compare retained state and decrypt all operational keys before trusting recovery.
Monitor readiness, backup freshness and monitor coverage externally; name incident and
abuse contacts and keep an out-of-provider reporting path.

For upgrades, take/verify a backup, read schema compatibility requirements, retain
both running application images, then publish in CI and recreate provider/web client together.
Migrations 79/80 change content/evidence readers and forbid mixed old/new serving;
see [content storage](../../../../docs/content-storage-and-attachments.md) and
[evidence storage](../../../../docs/verification-evidence-storage.md). Code rollback
must preserve the database overlay, current volume and compatible schema readers.
Never restore an old dump over newly accepted writes as an application rollback.

The checked-in `provider-ops.sh`, backup scripts and one-time setup helpers include
Haili-specific paths, domains, bucket names and policy checks. They are examples for
operator adaptation, not generic installers. Do not install them unchanged for a
new domain. [Haili operations](../../../../agents/haili-operations.md) describes the
installed Haili environment; use your own reviewed service supervision, backup and
least-privilege administration configuration.

Public transfers are optional. Enable `PUBLIC_MANAGED_TRANSFER` only with the pinned
`PLC_MANAGED_MONITOR_ORIGIN`/`PLC_MANAGED_MONITOR_PUBLIC_KEY` and the participating
providers' [readiness requirements](../../../cli/docs/custody-transitions.md#production-enablement-required-versus-deferrable).
Custody transitions and Connections are separate switches. Supported settled
connections survive moves; pending work and unsupported history remain blocked.

## Inbound email bridge (optional)

The bridge receives newsletters for per-subscription aliases and delivers them
as hails; see [spec/email-bridge.md](../../../../spec/email-bridge.md). It needs
four settings in `.env`, a reserved `email` account claimed like the
administrator, an ingress adapter such as the
[Cloudflare Worker](../cloudflare-email-worker/README.md), and the converter.

The converter is the `email-converter` service. It runs from the provider image,
holds no keys, and connects to the database as `email_converter`, a role limited
to the intake queue. `provider-ops.sh` manages it only when the deployed release
defines it and `EMAIL_CONVERTER_DB_PASSWORD` holds 43 base64url characters: it is
then pinned to the provider's digest, recreated on every deploy and rolled back
with the provider. A rollback to a release without it stops it.

After the first release that includes it is deployed, with the password in
`.env`, create the role and start the converter:

```sh
sudo -n /usr/local/sbin/hail-provider-ops email-converter-role
sudo -n /usr/local/sbin/hail-provider-ops logs email-converter 50
```

The command reads the password from `.env` and sends it to PostgreSQL on
standard input. Running it again updates the password.

## Deploy prebuilt application images

Build the separate provider and web-client images on GitHub Actions using the
[image release procedure](../../../../agents/release-process.md#provider-and-gui-images).
The public Compose file intentionally has no build definition. Do not run Vite,
adapter-node or Docker builds on a live provider host. `HAIL_PROVIDER_IMAGE` and `HAIL_WEB_CLIENT_IMAGE` select
separate immutable images on a fresh deployment. The local
`hail-server-ts:public` fallback exists only for transition from existing installs;
it is not a published release reference.

On the managed Haili host, the installed `hail-provider-ops` wrapper takes both a
full commit SHA and two GHCR digests (provider, then web client). It stores image selection in
`/etc/hail-provider-release/compose.json`, outside the Git checkout. When using
Compose directly on that host, append `-f /etc/hail-provider-release/compose.json`
after the existing Compose/database files. Preserve this file during backup and
restore. The wrapper never rebuilds and recreates only GUI/provider, leaving
PostgreSQL and Caddy running. Brief application restart time is still possible;
this is not a rolling, zero-downtime deployment system.

After separately installing the updated wrapper, successful deployments clean up
obsolete wrapper-owned rollback images while retaining every container's images,
the verified rollback pair and manual/foreign aliases. Preview cleanup with
`hail-provider-ops image-retention`; explicitly apply it with `--apply`.
Deploy refuses insufficient storage (3 GiB before pulls, 1 GiB afterward).
See [bounded retention and installation](../../../../agents/release-process.md#bounded-local-image-retention).
These commands never prune volumes, backups or build cache. Publishing application
images alone does not update the root-owned operations wrapper.

## Haili split-origin cutover

The operator has chosen a **fresh installation** using the
[new-provider guide](../standalone/README.md#replacing-a-disposable-pre-launch-provider).
The checklist below applies only if retaining existing identities instead.

The public profile now requires `PROVIDER_DOMAIN=svr.haili.app`,
`WEB_CLIENT_DOMAIN=haili.app`, and `NATIVE_ADDRESS_DOMAIN=haili.app`.
They are distinct roles: API/federation/media, browser/passkeys, and addresses.
Configure both Cloudflare hostnames to the same loopback tunnel listener. The
DNS record alone is insufficient: the tunnel must accept the new hostname and
preserve Host. Set `_hail-provider.haili.app TXT "v=hail1; provider=svr.haili.app"`.
Custom domains must likewise delegate to the new provider hostname.

This is a coordinated cutover, **not a routine image-only rollout**:

1. Inventory existing PLC service endpoints, account credentials, custom-domain
   authorizations, pending signups/invitations and in-progress transfers. Back up
   the database, recovery material and current environment/ingress configuration.
2. Rehearse signed PLC service-endpoint updates to `https://svr.haili.app/hail`
   for retained identities, including dependent published profiles and active
   relationships. DNS and SQL edits cannot replace owner-authorized signed PLC
   operations. Do not change public DNS while these preparations are incomplete.
3. Pending signup/invitation and custom-domain issuance records bind the old
   provider origin; finish or explicitly retire/reissue them. Retained delegated
   domain registrations need a separately reviewed data transition. Do not
   silently rewrite ownership proofs. CLI users obtain new credential files
   bound to `https://svr.haili.app`; do not relax credential-origin validation.
4. Preserve existing passkey RP ID/origin `haili.app` / `https://haili.app` and
   host-only session cookies. Set the three environment values above. Keep the
   current public-registration setting, database/image overlays and volumes.
5. Apply the reviewed tunnel/Caddy configuration through existing privileged
   access, coordinated with the verified provider/GUI images. The installed
   application wrapper recreates only provider and GUI: it does **not** reload
   Caddy or add the new Caddy environment value. A separate ingress recreation
   is required; do not change wrapper privileges to accomplish it.
6. Verify both hosts, unchanged passkeys and registration policy, JSON API calls,
   CLI browser login, address discovery, and authenticated avatar/attachment
   redirects whose final URL is `svr.haili.app`. Raw media requests on `haili.app`
   must fail. The original `/health/ready` remains a JSON-only ingress route for
   the installed operations wrapper.

No automatic account/PLC migration is included in the application change.
Provider transfers still have a protocol limitation: destination native domains
are tied to service hostnames, and source fencing rejects delegated-domain
addresses. Keep transfers disabled for the split Haili profile until that
interoperability decision is implemented and rehearsed; do not bypass the checks.
Same-provider custody changes use the explicit native address domain.

Before signed identity changes, rollback restores the old images, three-origin
configuration and ingress together. After signed changes, image rollback alone
is insufficient: review identity and endpoint reachability before reversal.
Never restore an old database over new writes. Keep prior images and backups.
