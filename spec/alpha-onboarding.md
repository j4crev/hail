# Reduced-Assurance Alpha Onboarding v1

Status: approved early-product direction; local reference implementation in
progress. Not a claim of production portable/managed onboarding conformance.

The reference monitor's provider registration and service-credential authorization
are specified in [monitor providers](monitor-providers.md). Individual provider
credentials do not replace owner-signed genesis or verified consumer-email binding.

The identifier `reduced-assurance-alpha-v1` distinguishes an early managed-account
onboarding deployment that uses a monitor under the provider operator's control.
It does not change federation objects, canonical PLC registration, key roles or
the baseline independent-monitor requirements in [account-onboarding.md](account-onboarding.md)
and [managed-custody.md](managed-custody.md).

## Scope And Disclosure

- The initial alpha path supports new managed identities only, with owner-held
  recovery and explicit managed-custody consent.
- The user must separately accept the reduced-assurance monitoring disclosure
  before reservation. Its profile identifier is retained with the preparation
  and immutable activation evidence.
- The operator pins the monitor origin and public key. A user or request cannot
  substitute an arbitrary monitor for the configured alpha monitor.
- The monitor remains useful for unexpected changes and operational failures,
  but its operator can suppress alerts. Separate hosting, different domain names
  and valid signatures do not prove administrative independence.
- External alerts and timely owner action remain necessary. Neither the monitor
  nor possession of a backup guarantees recovery within PLC's 72-hour window.
- Existing strict-public accounts and independent-monitor checks are not
  downgraded by enabling the alpha path.

Suggested disclosure:

> Reduced-assurance alpha: Hail's monitor is operated by the same operator as
> this provider. It can detect unexpected identity changes and monitoring gaps,
> but does not provide independent protection against that operator suppressing
> alerts. You retain your own recovery material. Recovery remains time-sensitive,
> and a recovery backup alone does not guarantee protection.

## Preserved Requirements

Only administrative monitor independence differs. Preserve owner recovery-key
generation and verified independent backup, exact full-state owner signatures,
distinct provider signing roles, canonical `https://plc.directory` writes,
exact-byte retries, validated public read-back, fresh cryptographically verified
monitor evidence, healthy monitoring, tested external alert delivery and full
address activation verification.

The managed custody key-layout identifier remains `hail-managed-custody-v1`;
the separate monitoring label makes clear this deployment does not satisfy that
profile's full independent-monitor production requirements. Do not call the
alpha an independently protected or production-conforming managed account.

## Persistence And Enforcement

The reference implementation records `monitor_assurance` on onboarding
preparations and immutable activation evidence. Existing records retain their
previous `independent` declaration; migration does not independently establish
or reassess historical physical custody or administrative independence.

Alpha managed custody evidence uses `verification_mode=reduced-assurance-alpha-v1`,
not `strict-public-v1` or `poc-local`. Account status must expose this distinction.

Existing monitor attestation formats and signature contexts authenticate the
reviewed observation; their historical `independent` context names are not proof
of administrative independence. The separately retained assurance label is
mandatory even when those existing signed observation formats are reused.

Strict-public and alpha activation services must refuse each other's
preparations. The database also requires activation assurance to match its
preparation, so an older writer defaulting to `independent` cannot activate an
alpha preparation under the wrong label. Rollback refuses to discard retained
alpha preparations or evidence.

The alpha label is not automatically portable transfer or custody-transition
evidence. Those operations remain gated until their continuity and assurance
handling has been explicitly reviewed and implemented. Do not relabel alpha
history as independently monitored to make an existing transition pass.
The reference implementation rejects alpha managed transfer authorization and
managed-to-owner custody transitions. A database guard also prevents deleting
or changing an alpha managed custody record's assurance label through existing
transition writers.

## Enablement Gates

The local service supports this distinction, but no public alpha signup route
or production deployment is enabled by this document or migration alone.

Before enabling consumer signup, complete authenticated automatic monitor
enrollment, verified per-user external alert delivery, a resumable browser
ceremony and narrow, terminal signup capabilities that never issue a full-access
browser API credential. Review the full lifecycle under interruption and replay.

Promotion to an independently monitored profile requires new verified monitoring
evidence and an explicit transition policy; it must preserve the alpha history.

## Account deletion and managed monitoring

This is reference-provider policy and an alpha service API, not a federation
operation or authorization to stop independently arranged monitoring. Ordinary
account deletion never publishes a PLC tombstone or changes the DID document.

For a managed account whose retained preparation declares
`reduced-assurance-alpha-v1`, successful local deletion must durably record
cleanup responsibility in the same transaction as closure. Record the account
ID, DID, original genesis CID and pinned monitor key, not a reusable Hail
address. Previously closed accounts with this evidence are backfilled on upgrade.
Other custody/assurance profiles do not enter this cleanup path. Failure to
record responsibility must roll back closure. Network failures must not undo
local deletion: retry cleanup until both services acknowledge it, including
after process restart or loss of a successful response. The browser must disclose
that cleanup can be delayed and that the PLC identity and independently arranged
monitoring remain.

The reference worker first removes the security-email destination, then stops
the configured monitor. It refuses a different configured monitor key. Each
request is `POST`, `Content-Type: application/json`, with no content encoding,
redirect following, or user-selected destination. The exact JSON object is:

```json
{"did":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa","operationCid":"<canonical genesis DAG-CBOR CID>"}
```

No extra or duplicate fields are allowed. `did` must be canonical `did:plc`;
`operationCid` must be a canonical CID with DAG-CBOR codec and SHA-256 multihash.
The APIs are:

- Monitor: `/api/v1/onboarding/stop`, authenticated with the individual provider's
  enrollment bearer credential. Maximum body: 1024 bytes.
  The retained bootstrap CID and enrollment owner must match. The reviewed
  bootstrap's Hail service must name the authenticated provider, and the alert
  destination must equal its registered receiver's `/hail/signup`. These checks scope removal to the managed
  signup integration, including existing enrollments. An independent webhook or
  missing bootstrap is refused. Repeated stops of the same enrollment succeed.
- Email receiver: `/signup-email/remove-monitoring`, authenticated with the
  existing provider signup-email bearer secret. Maximum body: 4096 bytes. A
  retained recipient or stop record with a different CID is refused. Otherwise
  delete the recipient and its retained signup email record and retain a minimal
  DID/CID stop record. Missing recipients are idempotent success. Binding the DID
  again is refused, and subsequent valid signed consumer alerts are acknowledged
  and discarded without email delivery.

Both return empty `204` on success with `Cache-Control: no-store`; malformed
requests return `400`, invalid authentication `401`, incorrect content type or
encoding `415`, excessive body size `413`, and enrollment mismatch `409`.
The monitor also applies its existing rate limit (`429`, `Retry-After: 15`).
Failures, including transient service errors, remain pending at the provider.

Stopped monitor records retain audit evidence and a stop timestamp. They are
excluded from polling, new notification claims, and both ongoing and onboarding
attestations; old enrollment retries must not restart them. Already delivered
email cannot be recalled, and an email already handed to the delivery service
may arrive after deletion. Independently configured monitoring is unaffected.
The reference worker retries with exponential delay capped at one hour. Its
outbox and stop evidence cannot be discarded through schema rollback.

Focused conformance evidence: `apps/server/test/signup-monitor.integration.test.ts`
(closure, outage, lost acknowledgement, replay), monitor enrollment API tests
(authentication and exact fields), and alert receiver tests (recipient removal,
idempotency and delayed alerts). This API does not define independent-monitor
cancellation, owner-authorized re-enrollment after closure, or audit erasure;
those remain separate, unresolved lifecycle protocols.
