# Public alpha monitor

This profile runs the monitor worker and its private PostgreSQL database. It polls
each enrolled DID's canonical `https://plc.directory/<did>/log/audit` endpoint.

The alpha deployment runs this stack on a separate VPS from both providers and
uses an external signed-alert email receiver. A deployment beside a provider or
within the same failure domain remains bootstrap evidence, not independent
production monitoring.

The reference heartbeat timer runs every three minutes and the receiver alerts
after six minutes without a successful authenticated heartbeat. Before installing,
adapt `heartbeat.sh` to your receiver URL and actual monitor container name; its
checked-in values are Haili-specific. Configure the matching private heartbeat
token in root-only `/etc/hail-monitor-heartbeat` and in your receiver. Install
`heartbeat.sh` as root-owned `/usr/local/sbin/hail-monitor-heartbeat`, install
the included service and timer in `/etc/systemd/system`, then daemon-reload and
enable the timer. The DID audit poll remains independent at four minutes.

## Prepare, but do not start yet

Use the monorepo with its pinned `vendor/did-method-plc` submodule initialized.
Run the following from the repository root. Set an independent random
`MONITOR_DB_PASSWORD` and your `MONITOR_ORIGIN` in `.env` before building. The base
Compose pins PostgreSQL 14.24; select and retain your database image/storage overlay
using the [fresh-provider pattern](../../../server/deploy/public/README.md#3-select-persistent-database-configuration),
with a distinct monitor volume. Include your overlay in every command below.

```bash
cd apps/plc-monitor/deploy/public
cp .env.example .env
chmod 600 .env
install -d -m 700 secrets
install -d -m 700 reviewed
docker compose --env-file .env build monitor
docker run --rm --network none --user root \
  --mount "type=bind,src=$(pwd)/secrets,dst=/keys" \
  hail-plc-monitor-ts:public bun src/cli/generate-key.ts /keys/monitor.pkcs8
chown -R 1000:1000 secrets
```

Store the printed public `did:key` and an encrypted copy of
`secrets/monitor.pkcs8` away from the VPS. Set `MONITOR_ORIGIN` to the reviewed
HTTPS operator identifier. The worker itself exposes no public port; enrolled
alert destinations are outbound HTTPS webhooks.

## Start and inspect

Start after DNS, the monitor key and alert webhook are ready:

```bash
docker compose --env-file .env up -d
docker compose --env-file .env logs -f monitor
docker compose --env-file .env exec db \
  psql -U monitor -d monitor -c 'SELECT last_seq,caught_up,last_healthy_at FROM monitor_cursor'
```

A fresh monitor may remain unhealthy until a DID is enrolled and a poll succeeds.
No global PLC backfill is required. A fresh successful poll must validate every
enrolled DID before the monitor can attest.

## Enroll the canary

For a first provider administrator, follow the complete
[administrator setup guide](../../../server/deploy/standalone/README.md#5-monitor-handoff-upload-enroll-and-retrieve-the-attestation).
It defines the identity values, labels each machine, and provides upload and
attestation-download commands. The abbreviated canary example below assumes
`DID`, `GENESIS_CID` and `ALERT_WEBHOOK` have already been set in the monitor shell.

After the first `racr account create` call returns the DID and genesis CID,
derive a public reviewed state file from the private signup state on the user
workstation:

```bash
jq '{did,rotationKeys:.operation.rotationKeys,verificationMethods:.operation.verificationMethods,
  alsoKnownAs:.operation.alsoKnownAs,services:.operation.services}' \
  /secure/hail-canary/signup.json > reviewed-plc-data.json
```

Copy only `reviewed-plc-data.json` to `deploy/public/reviewed/` on the monitor
host, then run:

```bash
docker compose --env-file .env exec monitor bun src/cli/enroll.ts \
  "$DID" "$GENESIS_CID" "$ALERT_WEBHOOK" /reviewed/reviewed-plc-data.json
```

After complete catch-up, healthy polling and delivery of the enrollment alert:

```bash
docker compose --env-file .env exec monitor bun src/cli/attest-onboarding.ts \
  "$DID" "$GENESIS_CID" > onboarding-attestation.json
```

Copy the attestation to the user workstation and resume the exact saved `racr`
signup command. Do not copy the monitor private key, database password, user vault,
recovery secret or provider credential between trust domains.

## Automatic Reduced-Assurance Alpha Enrollment

Automatic enrollment is optional and disabled without the declarations below.
Manual reviewed enrollment remains available. Same-operator monitoring must retain
its reduced-assurance label rather than claiming independent coverage.

The existing monitor process can optionally serve a multi-provider HTTPS API.
Configure the monitor's protected environment with:

```dotenv
MONITOR_API_HOST=0.0.0.0
MONITOR_API_PORT=3001
MONITOR_API_ORIGIN=https://enroll.monitor.example.com
```

`MONITOR_ORIGIN` remains the monitor identity origin used in signed attestations.
`PLC_DIRECTORY_URL` must be exactly `https://plc.directory` when the API is enabled;
a private registry cannot be relabeled public. Without enrollment declarations,
the existing worker starts without an API listener.

The listener defaults to `127.0.0.1:3001`. `MONITOR_API_HOST` can select loopback
or `0.0.0.0` for a private container network; `MONITOR_API_PORT` can select a
nonprivileged port. The checked-in Compose file deliberately publishes **no new
ports**. Before deployment, review HTTPS termination, authenticated ingress and
any loopback container-port mapping. Never expose the plaintext listener or put
the service secret in browser code, URLs or logs.

On the provider, retain its existing signup-email configuration and add:

```dotenv
SIGNUP_MONITOR_API_ORIGIN=https://enroll.monitor.example.com
SIGNUP_MONITOR_TOKEN=<individual credential returned by registration>
SIGNUP_MONITOR_PUBLIC_KEY=did:key:z...
```

The API origin is a pinned transport address and may differ from the monitor
identity origin. The public key must match the account's retained monitor key;
the attestation origin must match its retained monitor origin. These declarations
require signup email and strict public PLC authority; leaving all three empty
keeps the provider orchestration endpoint disabled.

Providers use the [self-service registration guide](provider-registration.md) to
prove control of their provider and alert-receiver HTTPS origins and obtain an
individual credential. Credentials are stored hashed in the monitor database.
Disabling a provider credential leaves its existing monitoring and alerts active.
This version serves Hail managed enrollment across providers; it does not add
arbitrary DID subscriptions or replace the owner-signed genesis requirements.

### Ceremony

1. The owner verifies a recovery backup and signs the exact managed genesis.
   Existing provider onboarding registers and reads back that exact operation.
2. The browser verifies its external email through the provider email endpoints.
3. `POST /api/v1/signup-monitor` at the provider accepts only `signupId` and
   `accountId`, the existing signup bearer capability and the expected Origin.
   The provider looks up the owner-authorized genesis itself and binds the
   verified destination before contacting the monitor. It never accepts a
   browser-selected DID, CID, monitor key, webhook or PLC operation here.
4. The provider calls the monitor's `POST /api/v1/onboarding` with its
   enrollment service secret and `{signupId, signupHash, operation}`. No vault,
   recovery secret, browser token or account API credential goes to the monitor.
5. The monitor validates the genesis, top-owner signature, four distinct roles
   and the authenticated provider's registered endpoint. It independently checks the exact verified
   email binding at that provider's registered receiver using its existing monitor signing key
   and a purpose-separated, five-minute request. It does not receive the
   provider's email-service secret or rely on a submitted `emailVerified` flag.
6. The monitor validates the canonical DID audit and enrolls the complete reviewed
   state, pinning alerts to `/hail/signup`. Exact enrollment retries preserve
   the original checkpoint, coverage, alert ID and delivery state. Changed
   state/destinations or attempts to promote legacy unreviewed enrollment fail.
7. The normal worker polls every four minutes and retries queued notifications
   every five seconds. The consumer alert route refuses missing bindings and
   wrong enrollment CIDs; operator fallback and its deduplication receipts
   cannot satisfy consumer delivery.
8. Until a fresh healthy poll and accepted enrollment notification exist, the
   API returns `202` / `awaiting-monitor` with `Retry-After: 15`. No signature
   authorizes activation yet. Complete evidence returns `200` / `ready` and a
   fresh signed v2 onboarding attestation. Lost coverage, conflicting genesis,
   invalid history or missing verified email fails closed.
9. The provider verifies the returned signature, freshness, DID, CID, state
   digest, monitor key/origin and reduced-assurance label before returning it.
   The signup coordinator must durably retain the chosen activation artifact
   and reconcile ambiguous activation before requesting a replacement. The browser signup coordinator resumes the retained ceremony through passkey
   enrollment and fresh sign-in.

This API cannot approve unexpected updates, perform recovery, change custody,
export keys, replace an email destination or silently select independent mode.
New activation continues to use the existing public read-back and address checks.

### Pause and recovery

To disable a provider's automatic enrollment, disable its credential using
`monitor:providers disable ID`; preserve the existing
monitor key, database, polling, notifier and bound consumer webhook routes. Do
not downgrade a consumer webhook to `/hail` or remove the receiver's consumer
route while enrolled identities depend on it. Never reset a cursor or generate
a replacement DID to recover from an ambiguous API response.

## Enrollment ingress

The base Compose publishes no API port. For automatic enrollment, bind the monitor
API to `0.0.0.0:3001` inside the container and add only a host-loopback port mapping
in your private deployment overlay. Put a loopback reverse proxy in front of it and
route your HTTPS ingress to that proxy. Preserve the enrollment Host, POST
method and exact `/api/v1/onboarding`, `/api/v1/onboarding/stop`, and
`/api/v1/providers/register` paths. Keep the service-token check for enrollment and
stop; registration instead proves control of both HTTPS origins. Provider IP
allowlists are no longer required. Preserve the separate incident UI routes.

For Cloudflare, trust `CF-Connecting-IP` only on the connector's private loopback
boundary. See [the example](Caddyfile.enrollment.example). Set
`MONITOR_TRUST_PROXY=true` only when the backend is isolated and that proxy always
overwrites `X-Hail-Monitor-Client-IP` from a trusted source. Other HTTPS proxies must
derive that header from their verified client address; never pass a caller-supplied
value through. Without trusted-proxy mode, the actual connecting IP is used.
Bypass caching and browser challenges for the enrollment hostname/path; never require
an interactive Access login for provider requests. Keep the backend and origin ports
unreachable directly from the public network.

From the actual provider container, verify trusted TLS and unauthenticated `401`,
then authenticated invalid-payload `400` using its protected service token. Do not
print the token or create an identity as a connectivity probe. Verify a second
provider cannot enroll or stop the first provider's identities. Reverify after changing
networking or recreating containers.

### Upgrade from a single-provider installation

Back up the database, key, environment and overlays first. Stop the old worker
before importing ownership. Using the new monitor image with the old protected
environment still available, run `bun src/cli/providers.ts import-legacy` as a
one-off command with the normal database/key/storage overlays. It migrates the
schema, hashes the existing service token, and attaches only reviewed enrollments
whose original provider endpoint and `/hail/signup` receiver both match. Manual
enrollments, original checkpoints, stopped records and notifications remain intact.
The command is idempotent and refuses a conflicting existing provider registration.

Then remove the three `MONITOR_ENROLLMENT_*` settings from the effective runtime
environment and Compose overrides, retain the listener settings, set the public API
origin, and start the new worker. Startup refuses the obsolete declarations to avoid
silently running the wrong credential model. Existing providers retain their token;
they do not need to re-enroll users. Update ingress to remove provider-IP admission,
add the registration route, and overwrite the trusted client-IP header if enabled.
Verify both IP families, valid/invalid credential handling and retained polling.

Roll back application/configuration together if needed. Preserve the additive
provider tables and ownership column rather than running the destructive schema
rollback; the prior worker ignores them and uses its saved single-provider settings.
Once other providers have enrolled, the old single-provider worker cannot serve
their management requests: prefer a forward fix or explicitly pause new enrollment.
Never reset the monitor database or signing key as part of this upgrade.

## Backups and existing Haili installation

Back up the database, signing key, environment, Compose overlays and connector
configuration in encrypted off-host storage. Retain the monitor's public-key pin
and identity origin. Restore into an isolated database on its recorded PostgreSQL
major and verify retained audit/approval/alert rows and the signing key before use.
Do not reset coverage history, replace consumer webhooks or approve unexpected state
merely to make a health check pass. Keep polling and notification working when
pausing new enrollment.

The installed Haili monitor builds from `/opt/hail` while retaining protected
legacy storage/configuration paths. Its overrides and operations configuration live
under `/etc/hail-monitor-enrollment`; `compose.postgres.yaml` selects its database.
Every deployment, backup and rollback must preserve those overlays. Application
rollback never restores an old database over new observations. The installed
root-owned wrapper is separate from a repository checkout and requires a reviewed
privileged installation to update. Do not rerun a one-time host bridge on a converted
host. Fresh independent deployments should use their own paths and operator policy.

## Public incident review rollout

This is a separate monitor/receiver release; provider and GUI images do not change.
Deploy the updated email receiver before enabling links. Deploy the monitor with
migration 8 and the built browser bundle, then explicitly configure
`MONITOR_INCIDENT_ORIGIN` as a canonical HTTPS origin on this monitor's tunnel.
The existing private API listener serves the incident pages as well as enrollment.
No new plaintext/public container port is needed. The incident origin must be
reachable by users, independently of enrollment credentials.

Keep `/api/v1/onboarding` and `/api/v1/onboarding/stop` under their authenticated
method/host restrictions. Add a separate host-specific matcher for
`/incidents/*` and only GET/POST; proxy it to the same loopback backend. All other
paths remain denied. Use `configure-incidents.py --check` then `--apply` through
separately approved privileged access on an installed host. The script retains
private copies of the prior Caddyfile and Compose override, sets only the incident
origin in the existing override, validates Caddy syntax before replacing files,
and prints the two services requiring recreation/restart. It does not alter the
root-owned operations wrapper, sudo/SSH policy, database overlay or tunnel routes.
The chosen origin must already route to this tunnel (the existing enrollment
hostname is suitable). Changing checkout source alone does not install this config.

Disable query/body/cookie logging and third-party analytics on the entire incident
route at every ingress layer. Keep edge rate limits and no-cache policy; bypass
cache/browser challenges for API requests. No email token belongs in health probes,
operator logs or screenshots. Check a synthetic non-secret UUID page returns the
review UI and its JS/CSS, response protections are present, unauthenticated `/data`
returns 401, cross-origin POST returns 403, and unauthorized enrollment still fails.
Do not send real alerts or publish PLC operations to smoke-test production.

App rollback does not roll back schema or erase signed recovery attempts. Email approvals remain separate from local-owner attestations, including under
older runtimes. Disable public incident ingress when rolling back to a runtime
without incident routes. Preserve signing keys so
outstanding deterministic links and retry payloads remain stable. Preserve the
receiver's existing email routing, recipient verification and durable deduplication.

## Retiring a dedicated test provider

A fresh provider installation does not clear this monitor or the public PLC
registry. To start a dedicated test monitor with no old watches, follow
[archive and restart monitoring](reset-test-monitor.md). It retains the existing
PostgreSQL storage and signing key, archives the old database, and creates an
empty replacement. Do not use it on a shared monitor with identities that still
need coverage. External email receiver state has its own lifecycle.
