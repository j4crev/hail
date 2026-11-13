# Reference monitor provider registration and enrollment

This is the reference monitor's optional HTTPS service API, not Hail federation
or a new PLC authority. It supports multiple Hail providers with separate service
credentials. Generic public DID subscriptions, annual renewal/expiry,
and self-service replacement of an existing provider registration remain outside
this version. Same-operator monitoring retains its reduced-assurance label.

## Self-service registration

Registration is specified in [shared monitor receiver and registration v2](monitor-receiver.md).
It proves control of the provider (and optional web) origin, verifies an operator
email, and issues a monitor enrollment credential and a shared-receiver
credential together. v1, which required each provider to run its own receiver,
was removed.

## Managed enrollment authorization

Existing `/api/v1/onboarding` and `/api/v1/onboarding/stop` request bodies and
onboarding attestation formats remain unchanged. A bearer credential selects one
enabled provider registration. That registration fixes the accepted genesis service
origin and the consumer binding/alert receiver; requests cannot supply replacements.
The monitor retains enrollment ownership independently of the current PLC service
endpoint. A provider cannot adopt an existing manual enrollment, change another
provider's destination, or stop another provider's monitoring, even when it knows
the DID, genesis CID or receiver URL. A service-origin change is not a transfer of
this authorization. Stop leaves its existing tombstone and evidence intact.

The existing owner-signed exact Hail genesis checks remain mandatory. Before
enrollment, the provider binds the user's verified security email to the exact
signup/DID/CID; the monitor independently requests confirmation from the registered
receiver using its purpose-separated signed binding request. A caller's assertion
that email is verified is insufficient. Only after valid PLC evidence, healthy
polling and successful enrollment-notification delivery may onboarding attestations
be issued. A provider registration is neither user-email verification nor DID-owner
proof. Incident recovery still requires the separately owner-signed PLC operation.

## Reference admission policy

These are initial deployment limits, not protocol promises: per provider, 60
authenticated requests per minute (persisted in PostgreSQL), 100 active identities,
and 20 new identities per rolling day. Ownership and identity quota checks are
serialized with insertion; exact retries do not consume new-identity capacity.
Public admission stops at 100 registered providers or 1000 active identities.
Manual operator enrollment is outside public admission and must respect capacity.

The single reference process additionally bounds unauthenticated enrollment traffic
to 600 requests/minute, four concurrent enrollment requests and one per provider;
registration to 20 requests/minute and two concurrent requests. Source limits are
120 enrollment requests/minute and five registration attempts/minute. IPv6 sources
are grouped by /64; the source-counter map is bounded. These secondary counters
reset on restart; a multi-replica deployment needs shared edge limits. Trusted proxy
headers may be used only on an isolated backend with header overwrite at ingress.
Missing or malformed source addresses share the restrictive unknown-source bucket.

Rate/capacity refusal does not remove existing coverage. Credential revocation and
provider enrollment disablement do not stop polling, revoke incident access or
discard alerts. Operator actions, existing polling backpressure and notification
retry behavior remain separate from new-provider admission.

## Migration and verification

Migration 9 adds provider registrations and nullable enrollment ownership without
rewriting checkpoints, signatures, observations or notifications. An explicit
operator import hashes the previous secret and attaches only reviewed enrollments
matching the old provider and consumer receiver; ordinary public registration
cannot claim those rows. Independently/manual-enrolled rows remain unowned.
Retain backups and old configuration for application rollback. Do not delete the
new ownership tables as an ordinary rollback; old software cannot serve newly
registered providers. The public worker rejects obsolete single-provider settings.

Conformance coverage: `provider-registration.integration.test.ts` checks registration v2
(see [monitor receiver](monitor-receiver.md#conformance-coverage));
`providers.integration.test.ts` checks hashed credential rotation, independent
limits, concurrent quota admission, ownership and preserved monitoring;
`signup-monitor.integration.test.ts` verifies the existing end-to-end email binding,
notification and attestation requirements with registered provider credentials.

## Managed handoff and retirement v1

`POST /api/v1/onboarding/handoff` uses the destination provider's credential,
uncoded JSON (maximum 1024 bytes; [request schema](schemas/monitor-handoff-v1.json)), and exactly `did`, `operationCid`, `transferId`.
DID and DAG-CBOR/SHA-256 CID encodings must be canonical; transferId is a lowercase
UUID. Success is `200` with exactly those three fields plus boolean `managed`.
The request shares onboarding admission limits. Invalid input is `400`, oversized
body `413`, wrong content type/encoding `415`, authentication failure `401`/`403`,
rate refusal `429`, and refused/unavailable handoff `409`.

The monitor MUST validate the current canonical PLC audit, retained history
continuity, exact operation CID, and destination Hail service endpoint. The current
operation MUST be signed by the highest-priority recovery key in the monitor's
trusted expected state. A lower-priority provider rotation signature is insufficient.
Key replacement that differs from this trusted owner requires separately approved
expectation review before handoff; the API cannot approve it implicitly.

For a managed enrollment, the monitor atomically records the destination owner and
new management CID. An immutable transfer receipt permits exact retries while that
management state remains current. Conflicting transfer IDs, stopped enrollments,
and stale retries fail closed. A valid endpoint change alone does not transfer
management. Unowned/manual or absent monitoring returns `managed:false`; it MUST
NOT be adopted. Handoff preserves the bootstrap, expected PLC state, coverage,
notifications and verified security-email receiver. It does not acknowledge an
incident or extend an attestation's assurance. Moving to another receiver requires
a future independently verified transition; this version retains the old receiver,
even if the destination provider registered a different alert origin.

Before committing handoff, the monitor MUST successfully claim control of the
retained receiver binding using the signed lifecycle protocol below. After claim,
the receiver MUST reject direct provider removal and preserve monitor control on
exact binding retries. This prevents the former provider's email-service credential
from bypassing monitor ownership checks.

`/api/v1/onboarding/stop` still accepts exactly `did` and `operationCid`; the CID
now identifies the **current management generation**, initially the genesis CID
and subsequently the handoff operation CID. Both authenticated provider ownership
and management CID MUST match. A delayed request from A cannot stop B, nor can
A's original request stop monitoring after A→B→A. Stop marks polling/attestation
inactive immediately and durably queues signed cleanup of the original receiver.
It retains audit and tombstone evidence and never resumes through enrollment retry.
An already in-flight external email cannot be recalled.

Credential disablement only blocks API requests. Explicit operator retirement is
separate: `monitor:providers retire ID EXPECTED_ACTIVE_COUNT` disables credentials,
permanently retires the registration, stops only its currently owned enrollments,
and queues receiver cleanup in one transaction. A count mismatch aborts. Previously
transferred identities and manually managed identities are untouched. Retirement
cannot be reversed using credential enablement or self-service registration. A
provider can also retire its own registration
([deregistration](monitor-receiver.md#deregistration)), and a confirmed
[replacement](monitor-receiver.md#replacing-a-registration) retires the registration
it replaces. A retired registration no longer reserves its origin, so the origin can
register again as a new provider with new credentials.

### Signed receiver lifecycle v1

`POST /hail/signup/lifecycle` accepts the [lifecycle schema](schemas/monitor-receiver-lifecycle-v1.json).
Exactly `type`, `version`, `did`, `operationCid`, `action`, `issuedAt` are present.
`type` is `hail.plc-monitor-receiver-lifecycle`, version is 1, action is `claim` or
`stop`, and issuedAt is integer Unix seconds within ±300 seconds. operationCid is
always the original receiver-bound genesis CID, **not** the current management CID.
The monitor signs the exact UTF-8 JSON bytes prefixed by
`hail.plc-monitor-receiver-lifecycle.v1\0` using its pinned Ed25519 key. Headers are
`X-Hail-Monitor-Key` and unpadded base64url `X-Hail-Monitor-Signature`.
Bodies are bounded to 4096 bytes; duplicate/extra fields and noncanonical CIDs fail.
Other signature contexts, including ordinary alerts, MUST NOT authorize lifecycle.

Claim requires an existing matching verified recipient, atomically marks it
monitor-controlled, and is idempotent. Stop erases the matching recipient and
retained signup record and retains a DID/genesis-CID tombstone. Exact stop retries
return `204`; conflicting bindings, absent unknown bindings and attempts to claim
a stopped binding return `409`. Invalid signatures return `401`, invalid fields or
stale timestamps `400`. Successful claim and stop return `204` without email data.
The monitor regenerates timestamps/signatures on bounded, durable cleanup retries;
it never gives the provider a replayable signed stop capability.

Reference monitor migration 10 adds management CIDs, handoff receipts, explicit
retirement and receiver cleanup without rewriting existing evidence. Provider
migration 108 tracks current serving-generation bindings and pending handoffs.
The destination worker discovers successful public activations from selected,
verified cutover evidence, checks its monitor pin and current serving generation,
and retries handoff; stale generations are superseded. Different-monitor and
independent enrollments are not adopted. Existing account-deletion restrictions
for retained migration history remain in force; this change does not discard
migration evidence to permit deletion. Provider account closure commits cleanup
responsibility with closure; only the monitor authorizes receiver removal.

Conformance: `lifecycle.integration.test.ts` covers owner versus provider signatures,
receiver outages, exact retries, A→B→A stale cleanup, revocation versus retirement,
and preserved coverage. `monitor-handoff.integration.test.ts` covers durable provider
retry and serving-generation fences. `alert-worker.test.ts` verifies signature-domain
separation, claimed-binding protection, idempotent erasure and no resurrection.
The [lifecycle vectors](vectors/monitor-lifecycle.json) describe required transitions.
