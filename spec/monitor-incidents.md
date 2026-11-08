# Monitor incident capabilities and PLC recovery

This is the reference monitor's HTTPS application contract, not a new Hail
federation credential or a change to PLC authority rules. No Hail provider login
is required. Separate hosting provides availability separation; shared operators
still provide reduced assurance, not administrative independence.

## Email delivery and authority

The existing signed `hail.plc-monitor-alert` version 1 envelope retains its seven
fields. Its `detail` may include `review: {url, expiresAt}`. The URL is a canonical
HTTPS monitor origin followed by `/incidents/<alert UUID>?token=<43-character
base64url capability>`. `expiresAt` is an ISO timestamp. The whole detail remains
covered by the alert signature. Human-readable change explanations and before/after
values remain in the email; the page adds freshly verified status and actions.
Email snapshots and directory timestamps are not refreshed by delivery or renewal.
Technical evidence copies omit the bearer URL.

A capability is scoped to one alert/DID. Possession authorizes reading its incident,
recognizing that alert's exact current operation, and submitting a separately
owner-signed recovery for its disputed branch. It does not authorize changing the
recipient, disabling monitoring, approving arbitrary/future operations, obtaining
provider credentials, or signing PLC operations. Forwarding or mailbox compromise
transfers these incident permissions. Mail providers and link-scanning services
can see the bearer; a confirmation button is not proof of human presence.

Reference policy: the unguessable 256-bit token is derived from a purpose-separated
Ed25519 signature under `hail.monitor-incident-capability.v1\0` over the alert UUID,
then SHA-256/base64url encoded. Only its hash is stored. Determinism makes retries
reproduce exactly the same signed alert without storing a plaintext bearer. This
internal derivation is not an interoperable signature format or an API for users.
Links expire 24 hours after alert creation. A consumed or expired link may request
a fresh email for up to 30 days; renewals are bounded to one per DID/hour and always
use the retained webhook/verified security-email binding. No browser supplies a
recipient. Renewal creates a separate alert with retained event details; it neither
approves the old state nor extends PLC recovery eligibility.

## Browser HTTP contract

All responses are no-store/no-referrer, deny framing, and load no third-party
resources. Deployments MUST exclude query strings, cookies and request bodies
from access logs, tracing and analytics. GET/HEAD must not consume capabilities or
approve changes. The HTML removes the query from browser history immediately;
this cannot undo exposure in the initial request, mail infrastructure or prior logs.

Routes under `/incidents/<UUID>`:

- `GET /`: generic page; no bearer-dependent mutation or private incident data.
- `POST /redeem {token}`: atomically consume an unexpired, unrevoked link; issue a
  random, hash-stored 30-minute `__Host-plc-incident` Secure/HttpOnly/SameSite=Strict
  cookie. Replay fails. Stopped monitoring invalidates links and sessions.
- `POST /renew {token}`: generic response whether eligible or not; queue only to
  the original destination. An expired link grants no browser session.
- `GET /data`: requires the scoped session. Returns event details, validated
  current CID/state/digest/audit, observed operation disposition, monitoring health,
  and saved recovery outcome. If fresh history cannot be verified, event details
  remain readable but current state is unavailable and mutations fail closed.
- `POST /approve {cid,digest}`: requires the session, a current full-state digest,
  and the alert's exact operation CID. Fresh directory and retained-history checks
  precede approval. Record `email-capability` authority and the alert ID, preserve
  evidence, and update the baseline. This approval MUST NOT satisfy independent
  monitor attestations that require local operator/owner review. It does not erase
  coverage gaps or establish that an identity is safe.
- `POST /recover {currentCid,operation,mode}`: requires the session, an unchanged
  reviewed current CID, an exact supported correction, and a valid top-owner PLC
  signature. `mode` is `restore` or `protect`. Save signed bytes/CID before network
  submission. A retry must use those exact bytes. Read back from the directory and
  poll the monitor; submission acknowledgement alone is not verified recovery.

All browser POSTs require exact configured Origin and `application/json`; no CORS
is provided. Request bodies are bounded to 16 KiB. The reference process caps the
browser surface at 300 requests/minute; edge admission/load protection remains an
operator responsibility. Link redemption and rate-limited renewal are separate
from confirmation of recognition or signing. Public incident ingress must not
expose or relax the private provider enrollment routes.

## Recovery choices and state transitions

The browser imports a DID-bound v1 user vault or v1 recovery package locally. Its
backup and secret are never sent to the monitor or provider. Audit replay verifies
signatures, CIDs, creation, chronological ordering and nullified recovery branches.
The server also verifies continuity with its retained audit. Recovery targets the
parent of the alert's operation, not an assumed current/previous array position.
For a validated terminal tombstone reported as an invalid-log incident, recovery
may target that terminal operation. Invalid/unavailable histories cannot authorize
a correction.

The kit must hold the parent's highest-priority recovery key. The disputed operation
must have been signed by a lower-priority key, and recovery must reach the directory
within PLC's 72-hour window measured from that operation's directory timestamp.
The reference UI conservatively rejects the boundary itself. The directory remains
the final authority. Clock skew, races and delivery delay do not extend the window.
A top-key compromise, missing kit or expired fork window has no automatic override.

`restore` copies the parent's rotation keys, verification methods, services and
aliases into a new operation pointing to that parent. This keeps the prior provider
configuration and authority. It is intended for accidental changes, and leaves a
compromised provider with its previous authority. It cannot guarantee availability:
provider-side key loss, account fences and other internal changes may require repair.

`protect` retains only the kit's recovery key in `rotationKeys`, replaces
`hail-identity` with the kit's owner identity key, and removes `hail-messaging` and
the `hail` service. Other verification methods/services and aliases come from the
parent. This interrupts Hail use; it neither migrates the account/data nor obtains
cooperation from another provider. Shared rotation-key removal can also affect
management of other applications on the DID.

Both choices nullify the disputed branch, including subsequent operations, under
PLC rules. The user reviews the full correction before unlocking and signing.
Neither choice undoes already executed messages/permissions, revokes provider
sessions/credentials, restores a mailbox or guarantees that current state is safe.
Recovery observation is recorded separately from baseline approval; recovery never
silently approves itself. No automatic provider account-repair protocol is added.

The independent workstation tool `src/cli/recover.ts` supports reviewed plan,
explicit signing through protected stdin, saved signed bytes, direct directory
submission and exact-CID reconciliation. It uses no monitor or provider credential.
It must be obtained from a trusted checkout independently of a suspected monitor.

## Verification and unresolved boundaries

`test/incidents.integration.test.ts` covers scoped/replayed/expired/revoked tokens,
renewal, stopped enrollments, deterministic delivery, stale review, attestation
separation, both recovery modes and ambiguous submission. `scripts/check-browser.ts`
executes audit validation and both locally signed corrections in Chromium with
network access blocked. Existing monitor recovery/continuity tests remain gates.

Automatic provider-state reconciliation after PLC recovery is unresolved and is
not implied by successful directory correction. Cryptographic proof of owner approval
for baseline changes is also separate from this mailbox-capability policy.
