# Haili production operations

## Application rollout entry point

Use the [routine production rollout](release-process.md#routine-production-rollout--operators-and-agents)
for provider/GUI releases. Build and publish in CI, then deploy the verified digest
through the installed wrapper. Never run Docker, Vite or adapter-node builds on
the live provider. A Git push alone does not deploy. Public registration is the
current intended policy; preserve it during application rollouts.


## Multi-provider monitor rollout (2026-11-10 UTC)

PR #60 deployed monitor commit `4cd643a6658aff80b722a9df752176600364df45`
after main verification run `42840166161`. The monitor checkout is `/opt/hailproto`;
the retained Compose site remains `/opt/hail/hail-plc-monitor-ts/deploy/public` with
both enrollment and PostgreSQL overlays. Signing key, database, two active DIDs,
and PostgreSQL uptime were preserved. One managed signup belongs to the Haili
registration; the manually enrolled administrator remains independently managed.

The enrollment API at `https://enroll.plcmonitor.us` accepts public registration
and authenticated provider calls without the former source-IP allowlist. Its
identity origin remains `https://plcmonitor.us`. The existing provider credential
was imported as a hash; provider images/configuration were unchanged. Actual
provider authentication passed from IPv4 and IPv6, unauthenticated requests returned
401, and public registration validation returned 400 for an empty request.

Encrypted backup `monitor-20261110T150225Z-67969294.tar.gpg` passed off-host checksum,
decryption and full PostgreSQL 18 restore; post-rollout backup
`monitor-20261110T150835Z-b5082724.tar.gpg` passed off-host checksum verification.
The prior monitor image is retained as `hail-plc-monitor-ts:before-multiprovider-20261110`;
protected previous configuration and rollout evidence remain under
`/var/lib/hail-monitor-enrollment/multi-provider-20261110/`. Installed health probes
now verify unauthenticated rejection without requiring a plaintext legacy token;
authenticated probes run separately from the provider. This section records PR #60,
not deployment of the subsequent lifecycle/handoff changes.

## Hostinger split-origin installation (2026-11-10 UTC)

Production hostname routes now use `haili-hostinger` (`100.99.115.0`, public IP
`2.25.253.153`) with `tag:haili-provider`. The API/media origin is
`https://svr.haili.app`; browser/passkeys and native account addresses use
`haili.app`. Host-only cookies and scoped media tickets remain enabled. Do not
route or deploy new application releases to the old Hetzner `haili-provider` node.

The fresh installation follows the [new-provider guide](../apps/server/deploy/standalone/README.md),
with Haili's `deploy/public` site profile at `/opt/hail`, PostgreSQL 18 overlay,
and immutable release overlay. The generic guide remains independent of
Cloudflare; this site's connector reaches Caddy at `http://127.0.0.1:8080` with
each hostname preserved. Initial setup uses the fresh-install Compose commands;
routine wrapper deployment requires an existing healthy provider/GUI and backup.

Installed release: `3202fb74c79a81eebd50f5d3b9c3e5156a635206`, publication run
`42748266990`. Exact images were verified and deployed through the installed
operations wrapper after first boot. Local and public origin routing passed.
PostgreSQL/Caddy uptime survived the wrapper rollout, and a working initial
release is retained for rollback. Subsequent documentation-only commits do not
require publishing different application images.

`admin@haili.app` is active with DID `did:plc:o3kveknoc4xnwwnaw7zetv2n`. The owner
completed passkey enrollment and login; operator access is granted. Public
registration was restored through the registration-policy service with its audit
entry. Recovery material stays on the operator workstation, backed up encrypted
off-host; private owner material was never sent to either service.

The dedicated monitor retains its signing key. Its old 15-identity database is
archived as `monitor_retired_20261110_033435` with connections disabled. The new
`monitor` database is pinned to `https://svr.haili.app`, has the new administrator
enrolled, and passed polling, enrollment-alert delivery and attestation checks.
Heartbeat scheduling resumed. Final pre-reset encrypted backup
`monitor-20261110T033251Z-2765cd08.tar.gpg` passed off-host checksum, decryption and
full PostgreSQL 18 restore. External alert-receiver state and public PLC history
were not reset.

The old Hostinger `hailproto.app`/`hailproto.dev` stack is archived and stopped
(13 containers, restart disabled). All four dumps restored with matching table
row counts; the encrypted off-host archive passed checksum and authenticated
decryption checks. Original volumes, images and keys remain retained.

The new provider's post-bootstrap backup `haili-20261110T034050Z.tar.gpg` passed
off-host restoration and application-schema/driver checks. All three retained
operational private keys decrypted and matched their public keys. The latest
pre-cutover Hetzner backup is `haili-20261110T032106Z.tar.gpg`; preserve its volumes
and recovery material. The operator powered off Hetzner, and its Tailscale node
is confirmed offline; the host has not been deleted.

### Completed host security and cutover checks

The operator verified independent root recovery through Hostinger's dashboard
console. Root SSH, password/keyboard-interactive authentication and X11 forwarding
are disabled; only the named `hailops` account can use SSH. A fresh private
`hailops` connection and wrapper status succeeded after reloading SSH, and a fresh
root connection was refused. Routine sudo remains restricted to
`hail-provider-ops`. The previous SSH configuration is retained under
`/root/hail-hardening-backup/ssh-before-root-disable` for console recovery.

Public SSH/web ingress is blocked on IPv4 and IPv6; private SSH and the tunnel
survived the kernel-update reboot. With Hetzner powered off, Hostinger's
`hail-provider-backup.timer` is enabled and active, with its next run scheduled
for 2026-11-11 UTC. The manual post-bootstrap backup and restore checks above
verify the installed backup path; the first scheduled run is still due.

The Cloudflare Browser Integrity Check exception is verified for the provider
and native-domain discovery/health paths: default non-browser requests return
successful readiness and WebFinger responses.

## Pre-launch development policy — developers and agents

**Build the intended system, not compatibility layers for our test data.** Hail
is pre-launch, with only a few test accounts and the founder's `j4@haili.app`.
Public hosting and the "public alpha" label below do not imply stable APIs,
protocol formats, database schemas, or backward-compatibility guarantees.

- Prefer a clean breaking change over legacy adapters, dual implementations,
  old-format readers, or reconciliation machinery whose only purpose is keeping
  these pre-launch records usable. Do not add permanent technical debt for them.
- Deleting/resetting obsolete application records and recreating test connections
  is an acceptable migration strategy. Identify the affected records and what is
  lost, keep related data consistent, and back up hosted data before cleanup.
  If the destructive scope is unclear, ask; this is not permission for an
  unspecified database wipe or deletion of keys or recovery material. External
  PLC identity history is not resettable application data.
- Keep security and correctness for the **current** design: signature checks,
  account isolation, disconnect/replay protection, and portable history created
  under the new design are still requirements. Reject or explicitly clean up
  unsupported old data rather than pretending it satisfies those requirements.
- Document breaking changes and the required cleanup/upgrade steps. Remove
  superseded compatibility code and tests rather than maintaining them forever.
- Revisit this policy explicitly before real external users or independent
  providers depend on a stable release; do not assume that commitment exists yet.

For the current portability work, this means **no legacy-proof reconciliation
subsystem solely to rescue existing test relationships**. Unsupported records can
be explicitly cleaned up and those relationships recreated under the new design.

## Ownership and response

| Role | Public contact | Acknowledge | Act |
| --- | --- | --- | --- | --- |
| Availability, keys and recovery | `ops@haili.app` | 30 minutes | 2 hours |
| Abuse and legal reports | `abuse@haili.app` | 1 business day | Immediately for credible active harm |

## Access and key handling

Haili administration uses ordinary key-based SSH over Tailscale. Public provider
and monitor HTTP use host Cloudflare Tunnels with loopback-only origins. Keep
unsolicited public ingress blocked in host and hosting firewalls for IPv4/IPv6,
while preserving outbound, established and private administration traffic.
The [provider setup guide](../apps/server/deploy/public/README.md#4-configure-https-ingress)
describes header trust, cache and browser-check boundaries. Monitor enrollment is a
public HTTPS transport with restricted admission, not a private-only tailnet API.

Provider PostgreSQL configuration lives in `/etc/hail-provider-postgres/compose.yaml`;
monitor configuration includes `/etc/hail-monitor-enrollment/compose.postgres.yaml`.
These select the PostgreSQL 18 storage independently of application releases.
Preserve overlays on every Compose operation and restore. Retained older volumes
are not rollback targets after either application has accepted new writes.

- Final SSH policy allows only the named `hailops` account with public-key
  authentication; root, passwords, keyboard-interactive authentication and X11
  are disabled. Independent dashboard-console recovery was verified before
  disabling root SSH.
- Passwordless sudo for `hailops` is limited to the root-owned provider/monitor operations wrapper.
  Root recovery uses the VPS console, not remote root SSH.
- Provider secrets and R2 credentials are root-owned mode `0600`. Database
  operational private keys remain encrypted by `KEY_ENCRYPTION_KEY`.
- The backup host has only the OpenPGP public recipient. Keep the encrypted
  private recovery key, its passphrase and one current credential backup off the
  provider host and test them quarterly.

### SSH agent versus sudo

SSH key authentication and sudo authorization are separate. If an agent-run
command fails with `Permission denied (publickey)`, first check whether its
environment has the correct `SSH_AUTH_SOCK`. An existing agent may already hold
the authorized, unlocked key even when direct use of the private-key file fails.
Inspect existing agent socket addresses with `ss -xl` and verify the selected
agent with `SSH_AUTH_SOCK=<socket> ssh-add -l`; use that same socket for SSH.
Do not start a replacement agent, generate another key or disable host-key
checking merely because an automated session did not inherit the socket.

Granting `NOPASSWD:ALL` does not fix SSH authentication. Routine provider status,
deploy, restart and rollback use `sudo hail-provider-ops ...` under the restricted
rule. New privileged configuration changes need separately approved access.
Routine access must retain wrapper-only sudo and key-only SSH authentication.

### Connect to the provider

The production provider is the Tailscale node `haili-hostinger`. Use the `hailops`
account; `hailops` by itself is not necessarily an SSH host alias on a developer
workspace. Resolve the provider's current Tailscale IP from `tailscale status` and
check the existing host-key pin before connecting:

```bash
tailscale status
provider_ip=100.99.115.0 # replace with the current haili-hostinger address
host_key_alias=2.25.253.153 # existing verified workspace pin
ssh-keygen -F "$host_key_alias"
```

The current operator workspace stores the Hostinger host key under its public
IP. Use that existing pin as `HostKeyAlias` while connecting over Tailscale:

```bash
ssh -o BatchMode=yes -o "HostKeyAlias=$host_key_alias" \
  hailops@haili-hostinger \
  'sudo -n /usr/local/sbin/hail-provider-ops status'
```

Set `provider_ip` to the address shown for `haili-hostinger` in `tailscale status`.
Do not bypass host-key checking when the pin is missing or mismatched; confirm
the node identity and establish the pin through the reviewed operator process
first.

If public-key authentication fails, inspect existing SSH-agent sockets rather
than generating keys or starting a replacement agent:

```bash
ss -xl | rg '\.ssh/agent/'
export SSH_AUTH_SOCK=/path/to/existing/agent/socket
ssh-add -l
ssh -o BatchMode=yes -o "HostKeyAlias=$host_key_alias" hailops@haili-hostinger \
  'sudo -n /usr/local/sbin/hail-provider-ops status'
```

Use only a socket that lists the authorized operator key. Keep routine commands
within the installed operations wrapper; direct `sudo docker` and broad sudo
access are not part of the host policy.

## Backup and restore

The nightly job creates a PostgreSQL custom-format dump plus the root-only
provider environment, encrypts the archive to fingerprint
`870DECF2F98318BCDE17D4B8333035D2650B0400`, uploads it to the private
`haili-production-backups` R2 bucket, downloads it again for a SHA-256 match, and
only then sends the backup heartbeat. Missing heartbeats alert after 26 hours.
No automatic deletion policy is enabled.

Quarterly, download a fresh object on a non-provider host, decrypt it, restore it
into a disposable instance of the recorded PostgreSQL major (both production
databases are now 18.6), compare schema and row counts, and
decrypt every retained account and prepared-transfer operational key. Record the
object name, digest, counts and result in protected operator records
with the backup; remove plaintext artifacts afterward.

The installed provider database
overlay at `/etc/hail-provider-postgres/compose.yaml` must accompany every Compose
operation, including application rollback. A major migration uses a new volume;
never attach 18 to a 14 directory or select an old volume after new writes.
Installed backup tooling includes the active DB image/version and database overlay
in its encrypted archive; restore on the recorded major, not a hardcoded 14 image.

## Monitoring and recovery thresholds

The Cloudflare Worker runs each minute. It alerts on state transitions and again
on recovery:

- `https://haili.app/health/ready` non-2xx or timeout after 10 seconds;
- no authenticated PLC-monitor heartbeat for 6 minutes;
- no verified encrypted provider backup for 26 hours.

Signed monitor alerts must be no more than seven days old and no more than five
minutes in the future. A Durable Object atomically claims each alert UUID,
retains completed IDs for 30 days and releases failed email claims for retry.
Treat Durable Object errors or repeated `503` delivery responses as alerting
failures; do not replace this claim with eventually consistent KV deduplication.

The monitor host sends a heartbeat only while its container health check passes.
Treat any alert as an incident. If no alert arrives during a quarterly simulated
failure, treat alerting itself as failed and use the Cloudflare Worker logs.

## Production limits

| Surface | Limit | Expected overload behavior |
| --- | --- | --- |
| Account API | 120 requests/minute/authenticated account or anonymous client | `429`, `Retry-After` |
| Envelope submission | 120 requests/minute/client; 16 KiB request | `429` or `413` |
| Grant publication | 120 requests/minute/client; 256 KiB request | `429` or `413` |
| Delivery status | 120 requests/minute/client; 16 KiB request | `429` or `413` |
| Body storage/retrieval | 1 MiB body | `413` at bounded request surfaces |
| Attachments | 25 MiB total/message; 20 files; 35 MiB upload JSON; 250 MiB editable uploads/account | `413` request limit, validation failure, or `409` upload allowance |
| Sender Profile retrieval | 64 KiB response | Verification failure |

Recalibrate after host, database, runtime or traffic-shape changes. Stop and
investigate failed readiness checks. Raising mutation limits requires measuring
the protected 500-ms response schedule and database contention separately.

Caddy is the trusted client-address boundary and must overwrite
`X-Hail-Trusted-Client-IP`; never forward a caller-supplied value. The provider
container must remain private to the Compose network. Transfer ingress also has
a separate, higher database-backed overload ceiling.

After an enrollment or migration incident, inspect passkeys, sessions,
invitations and prepared migration slots before cleanup. Unexpected passkeys and
orphan slots are not deleted automatically because bulk removal could destroy
legitimate recovery or standalone preparation state.

## Retained application images for rollback

The installed Haili wrapper takes a commit plus separate provider and web-client
image digests. It is root-owned and independent of this checkout; changing its
source does not update the installed wrapper. Install future wrapper or backup-tool
changes through existing reviewed privileged access.

The wrapper retains both running image IDs under local rollback tags before
replacement and records five fields: previous commit, provider reference/ID and
client reference/ID. For recovery from a pre-split backup, it also accepts a
verified three-field combined-image record and restores that image for both
services; unverified two-field records remain refused. Both images are verified
before rollback changes checkout or containers. Keep the record, its retained images,
release selection and database overlays. Application rollback is never database
rollback.

Provider and client share a reviewed release commit but have distinct image IDs.
Backups record both references. Haili keeps its existing `deploy/public` directory,
Compose project, `gui` service name and data volumes to preserve operational
identity. The independent fresh-install profile is `deploy/standalone`; do not
substitute it on the existing host.

The updated wrapper bounds automatic retention to images used by any container
and the verified previous release, while preserving manual/foreign aliases.
`image-retention` reports obsolete wrapper-created images; `image-retention --apply`
removes only those images under the deployment lock. It also runs after successful
rollouts, never after failed rollouts or as a low-space emergency prune. Minimum
free-space gates are 3 GiB before pulls and 1 GiB afterward; `status` reports free
space. Installation of the reviewed wrapper is separate from application rollout;
see the [retention procedure](release-process.md#bounded-local-image-retention).

Follow the [rollout procedure](release-process.md#routine-production-rollout--operators-and-agents)
for publication, deployment, recovery and future wrapper maintenance.
Regression checks: `bun run --cwd apps/server test -- test/provider-ops.test.ts`.

### Optional encrypted browser notifications

The reference provider leaves Web Push disabled unless all three settings are present:
`WEB_PUSH_VAPID_SUBJECT` (operator `mailto:` contact or HTTPS contact URL),
`WEB_PUSH_VAPID_PUBLIC_KEY`, and `WEB_PUSH_VAPID_PRIVATE_KEY` (canonical unpadded
base64url P-256 keys). Generate a dedicated pair on a trusted development/operator
machine using the installed `web-push` library's `generateVAPIDKeys()`; deliver the
private key through the existing secret configuration process. Do not print it in
release logs, commit it, or reuse identity/session encryption keys. Keep the pair
stable across restarts. The public and standalone compose profiles pass these
optional variables through. Routine application deployment does not generate keys
or opt users in.

After configuration and normal release verification, use Settings → Browser
notifications in a supported secure-context browser. Verify the “Notifications
enabled” notification, hide/close the client, deliver a test message, and check
that the generic mailbox-update notification opens the client and normal JMAP
sync retrieves it without marking it read. Check disable/re-enable, browser
permission revocation, logout and expired sessions. Browser/platform background
restrictions and `userVisibleOnly` enforcement must be checked on actual devices;
unit fixtures do not establish push-service interoperability.

Subscriptions are local to a credential/device, capped at seven days, and stop
when its session expires, idles out, is revoked or becomes migration-fenced. They
do not extend authentication. Users can enable again after signing in. Rotating
the VAPID pair requires browser resubscription. Disabling configuration removes
the advertised capability and stops delivery; retained rows remain subject to
expiry when re-enabled. Subscriptions are deliberately absent from portable
account history. Migration 0118 rollback requires removing unexpired subscriptions
first; preserve operator approval and the normal database rollback process.
