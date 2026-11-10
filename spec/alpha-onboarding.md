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
ID, DID, current management CID and pinned monitor key, not a reusable Hail
address. The initial management CID is the genesis CID. After a managed handoff
it is the new owner-signed PLC operation CID. Previously closed alpha accounts
with preparation evidence are backfilled on upgrade. The destination's retained
managed handoff binding also carries the current serving generation. Independent
monitoring is not adopted. Failure to record cleanup responsibility rolls back
closure; network failures do not undo local deletion.

The provider worker first requests `/api/v1/onboarding/stop`, authenticated with
its enrollment credential, with exactly `did` and `operationCid` in uncoded JSON
(maximum 1024 bytes). The monitor verifies current owner and management CID,
marks polling inactive, and durably queues signed removal at the retained
receiver. The provider retries until the monitor acknowledges; the monitor retries
receiver cleanup independently, including after restart or a lost response.
A changed configured monitor pin fails closed. Neither request accepts a
caller-selected receiver. See the complete [handoff and signed receiver lifecycle
contract](monitor-providers.md#managed-handoff-and-retirement-v1) for wire formats,
status codes, authorization and A→B→A stale-request protection.

The legacy provider-authenticated `/signup-email/remove-monitoring` endpoint is
retained only for bindings not yet claimed by the monitor. It MUST reject a
monitor-controlled recipient. Updated provider cleanup MUST NOT call it: removing
an email destination before monitor authorization would let an old provider
bypass handoff ownership. Signed lifecycle stop erases the recipient and retained
signup email record, retaining a minimal DID/genesis-CID tombstone. Exact retries
are idempotent; stopped bindings cannot be claimed or rebound.

The browser must disclose delayed cleanup and that PLC identities and independently
arranged monitoring remain. Existing account-deletion restrictions for retained
migration history remain unchanged; lifecycle cleanup does not authorize erasing
that history.

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
