# Shared monitor receiver and provider registration v2

Status: Current reference monitor service API, not Hail federation. Replaces
self-service registration v1 under the pre-launch policy; v1 is removed rather
than kept alongside. The verification document has a
[JSON schema](schemas/monitor-provider-registration-v2.json) and a
[fixed hash/field vector](vectors/monitor-provider-registration.json).

## Purpose

Today every provider must run its own *receiver*: the service that verifies a
user's security email during signup, confirms that binding to the monitor, and
emails that user the monitor's signed alerts. The reference receiver is a
single-tenant Cloudflare Worker with one shared provider secret, one signup
origin and Haili's sending domain. That blocks independent providers.

v2 makes one receiver, operated alongside the shared monitor, serve every
registered provider. A provider registers once and receives both credentials.

## Roles

| Party | Holds | Trusts |
| --- | --- | --- |
| Monitor | Provider registry, Ed25519 signing key | Provider origin proof, operator email proof |
| Receiver | Per-provider records pushed by the monitor; user security emails | The pinned monitor key |
| Provider | Monitor credential and receiver credential | The pinned monitor key and receiver origin |

The receiver is configured with the monitor's public key and accepts provider
records only from monitor-signed provisioning requests. The monitor is
configured with the receiver origin and uses it as every new provider's alert
origin; a provider cannot select another receiver.

## Registration v2

1. **Prepare.** The operator generates a 32-byte registration secret and publishes
   this document at `/.well-known/hail-monitor-registration` on the provider
   origin, and on the web origin when one is declared:

   ```json
   {
     "type": "hail.monitor-provider-registration",
     "version": 2,
     "monitorApiOrigin": "https://enroll.monitor.example",
     "providerOrigin": "https://svr.provider.example",
     "webOrigin": "https://provider.example",
     "registrationHash": "BASE64URL_SHA256_OF_SECRET",
     "expiresAt": 2000000000
   }
   ```

   `webOrigin` is optional (server-only providers omit it). The reference
   standalone Caddy routes this path on both hostnames to a file the installer
   writes; no application port is exposed.

2. **Request.** `POST /api/v1/providers/register` with exactly `providerOrigin`,
   optional `webOrigin`, `operatorEmail`, `registrationSecret` and `expiresAt`.
   The monitor verifies every published document as in v1, then asks the
   receiver to email a fixed-template eight-digit code to `operatorEmail`. It
   stores only the code hash and returns `202` with `expiresAt`. An exact retry
   within the code lifetime does not send another email; a `resend: true`
   retry does, subject to cooldown.

3. **Confirm.** The same request plus `operatorCode` verifies the code (five
   attempts, ten-minute lifetime), creates the provider, provisions it at the
   receiver and returns `200`:

   | Field | Use |
   | --- | --- |
   | `providerId`, `providerOrigin`, `webOrigin` | Registration record |
   | `token` | Monitor enrollment credential (`SIGNUP_MONITOR_TOKEN`) |
   | `receiverOrigin`, `receiverToken` | Receiver credential (`SIGNUP_EMAIL_ORIGIN`, `SIGNUP_EMAIL_TOKEN`) |
   | `apiOrigin`, `monitorOrigin`, `monitorPublicKey`, `limits` | As in v1 |

   Both credentials are derived from monitor signatures over distinct contexts,
   so an exact retry of a completed registration returns the same values without
   storing them. Only hashes are retained by the monitor and the receiver.

A verified operator email is the operator contact for credential rotation,
quota and policy notices. It is not shown to users and is not a security-email
destination for any DID.

### Replacing a registration

A provider that lost its credentials, for example after rebuilding its server,
registers again. When its origin already has an active registration with a
different `registrationHash`, the request **replaces** that registration:

- `operatorEmail` must equal the registered operator email, compared without
  regard to case; otherwise `409`. The error does not reveal the email on file. Origin
  proof alone is not enough: whoever controls the server could otherwise switch off
  monitoring of the provider's users, while a replacement also needs the operator's
  mailbox.
- A registration the monitor operator disabled cannot be replaced (`409`).
- Steps 2 and 3 are unchanged; the code goes to the registered email. Nothing changes
  until the code is confirmed. Confirmation then, in one transaction, retires the old
  registration (as [deregistration](#deregistration) does) and creates the new one.
- The monitor provisions the old registration's receiver record as disabled before
  the new one as enabled, so the old receiver credential stops working first. If
  either push fails, the monitor returns `503` and an exact retry completes it.

Monitoring of the identities enrolled by the old registration stops. The new
registration enrolls identities again as they are created or re-onboarded.

### Deregistration

`POST /api/v1/providers/deregister` with `Authorization: Bearer {token}` (the
monitor credential) and a body of exactly `{"providerOrigin": "..."}` naming the
credential's own origin. In one transaction the monitor retires the registration
exactly as operator retirement does: it disables both credentials, stops monitoring
every identity the registration currently owns, and durably queues receiver cleanup
for each. It then provisions the receiver record as disabled.

| Status | Meaning |
| --- | --- |
| `200` | `{"providerId", "providerOrigin", "deregistered": true, "stoppedIdentities"}`. A retry of a completed deregistration also returns `200`, with `stoppedIdentities: 0`. |
| `400` | The body is not exactly a canonical provider origin. |
| `401` | Unknown credential. |
| `409` | The credential belongs to a different origin. |
| `503` | Retired, but the receiver was not updated yet; retry. |

The credential remains usable only for retrying deregistration. A retired
registration no longer reserves its origin: the provider may register again later
and receives a new `providerId` and new credentials. Identities stop being monitored
without an email to their users; the provider should tell them itself. A provider
holding the credential can already stop monitoring each identity it manages, so
deregistration grants no additional authority.

## Monitor → receiver provisioning

`POST {receiverOrigin}/hail/providers`, signed with the monitor key under
`hail.plc-monitor-receiver-provider.v1\0` using the existing monitor key and
signature headers. Body: exactly `type: "hail.plc-monitor-receiver-provider"`,
`version: 1`, `providerId`, `providerOrigin`, `webOrigin` (string or null),
`tokenHash`, `enabled`, `issuedAt`. The receiver accepts it within five minutes of
`issuedAt` and applies the newest `issuedAt` per provider. Rotation, disabling
and retirement push a new record; an older record never overwrites a newer one.

`POST {receiverOrigin}/hail/operator-verification`, signed under
`hail.plc-monitor-operator-verification.v1\0`, with `email`, `code`,
`providerOrigin`, `expiresAt` and `issuedAt`, sends the fixed verification
template once per distinct body.

## Receiver behavior per provider

- Provider requests (`/signup-email*`) authenticate with the bearer
  `receiverToken`. Its hash selects one enabled provider record.
- Signup records, codes and rate limits are namespaced by provider; a provider
  cannot read, resend, verify or bind another provider's signup. Per-provider
  and global send limits both apply.
- **Bind** additionally carries the exact signed genesis `operation`. The
  receiver derives the DID and CID from it and requires its `hail` service
  endpoint to be `{providerOrigin}/hail`. A provider therefore cannot bind, and
  so squat or block, a DID registered at another provider.
- Removing monitoring is accepted only from the provider that bound the DID.
- Links in signup and invitation emails use the provider's registered
  `webOrigin` (or `providerOrigin` without one). Invitation URLs on any other
  origin are refused.
- Mail is sent from the receiver's configured addresses (reference:
  `welcome@notify.racrproto.com` and `security@notify.racrproto.com`) with the
  display name "Hail", and names the provider's origin in the body. A
  per-provider display name is not offered because it would let a provider
  impersonate unrelated brands from the shared sending domain.
- Monitor-signed binding queries, alerts and lifecycle requests are unchanged.
  DIDs are global; the binding records which provider made it.

## Operator health checks

The reference Worker keeps its deployment operator's own checks (provider
readiness, monitor heartbeat, backup heartbeat), but each is optional and off
unless configured. They alert only the deployment operator and never affect
provider records.

## Migration (reference deployment)

Existing provider rows keep their `alert_origin`. A monitor operator command
provisions an existing provider at the receiver with its current receiver secret
(hashing it, never storing it), so Haili's provider keeps working without a
configuration change. The receiver's single `SIGNUP_EMAIL_TOKEN` and
`SIGNUP_ORIGIN` settings are then removed. Recipient records bound before v2 have
no provider and remain deliverable; signup records in progress expire within 24
hours.

## Reference implementation

- Monitor: `src/provider-registration.ts` (API), `src/receiver-provisioning.ts`
  (signed client), `src/receiver-provider-wire.ts` (formats shared with the
  receiver), migration 11. `MONITOR_RECEIVER_ORIGIN` names the receiver; without
  it registration returns `503`.
- Operator commands: `monitor:register-provider prepare|request|finish` and
  `monitor:providers provision|receiver-import|rotate-receiver`. Enabling,
  disabling and retiring a provider re-provision it.
- Deregistration: `createProviderDeregistrationApi` in `src/provider-registration.ts`;
  migration 12 limits origin uniqueness to registrations that are not retired.
- Receiver: the Cloudflare Worker in `deploy/cloudflare-alert-worker`. The
  temporary `LEGACY_RECIPIENT_PROVIDER_ORIGIN` setting assigns recipients bound
  before v2 to that provider when it is provisioned.

Contact verification is required before credentials are issued, so an
unattended installer needs a reader of the operator mailbox to finish.

## Conformance coverage

`provider-registration.integration.test.ts` covers origin proof, the operator code
(attempts, cooldown, resend, receiver outage), exact retries, credential secrecy,
disabled registrations, deregistration (authentication, origin match, receiver
outage, idempotency, registering again) and replacement (registered email only,
nothing changes before confirmation, old credential disabled first, operator-disabled
registrations). `alert-worker.test.ts` covers provisioning signatures
and ordering, token rotation, provider isolation, genesis ownership on bind,
scoped tombstones, operator-verification email and the legacy migration.
`signup-monitor.integration.test.ts` runs provider signup, monitor enrollment and
the receiver end to end with a provisioned provider.
