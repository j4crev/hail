# Standards adoption: phase 0 baseline

Recorded 2026-11-10 against `2bf1a8b` and the working-tree standards plan in
[DESIGN.md](DESIGN.md#standards-adoption-direction). This is implementation
planning, not a new wire profile. Phase 0 inventories existing owners and defines
preservation gates; phases 1–8 still need their own implementation and evidence.
No deployment, cleanup, credential invalidation or format change is authorized by
this document. Existing tests below are coverage to reuse, not proof of the future
standards profiles.

## Shared ownership and preservation rules

The normative current-version inventory is [spec/README.md](../spec/README.md).
[Encoding](../spec/encoding.md), [CDDL](../spec/hail.cddl),
[TypeScript profiles](../packages/hail-codec-ts/src/profiles.ts) and
[Go codec](../packages/hail-codec-go/cose.go) own signed representation changes.
Update both codec implementations and their positive/negative vectors together.
[Vector provenance and commands](../spec/vectors/README.md) distinguish independent
format verification from live provider authority and database state transitions.

Apply the [pre-launch policy](haili-operations.md#pre-launch-development-policy--developers-and-agents):

- Preserve account-to-DID binding, current custody mode, independent owner/recovery
  keys and authority, external PLC history, active consent/revocation and replay
  protection. Login/session migrations cannot grant owner authority.
- Preserve exact authenticated bytes and the evidence that justified accepting
  them, including envelopes, Grants, statuses, bindings, connection/conversation
  history, attachment declarations and transfer manifests. Never reserialize or
  re-sign history and present it as the original evidence. Retained historical
  evidence does not automatically authorize a new action under current keys.
- Preserve current pending delivery, availability obligations, fences, serving
  generation and cutover authority. A format change cannot silently release a
  fence, resurrect a revoked Grant or turn an accepted submission into delivery.
- Unsupported obsolete application records may be explicitly rejected or cleaned
  up instead of gaining permanent compatibility readers. Before cleanup, enumerate
  affected records, dependent state and losses, back up hosted data, and document
  recreation steps. Unclear destructive scope needs clarification. This is not
  permission to delete identities, keys, recovery material or unspecified data.
- Each release must state its writer/reader cutover, handling of pending work,
  retained evidence and unsupported records, client upgrade/relogin steps, and
  rollback boundary. Once incompatible writes exist, reverting application images
  alone is not a data rollback. Keep migration/cleanup separate from deployment.

## Phase-by-phase implementation inventory

Paths below are responsible owners, not a proposal to create parallel services.
New spec destinations are explicitly marked **planned**; their schemas/vectors
must be added with the corresponding implementation, not implied to exist today.

### 1. HTTP and transport foundations

**Current behavior and reuse.** [Retriever](../apps/server/src/delivery/retriever.ts)
checks a single exact `sha-256` Content-Digest representation against transmitted
bytes, then separately checks decompressed bytes against the signed size/digest.
Its attachment path shares that digest helper. [Body routes](../apps/server/src/bodies/routes.ts),
[store](../apps/server/src/bodies/repository.ts) and
[service contract](../apps/server/src/bodies/service.ts) own serving and the concealed
failure boundary. [SafeHttpsTransport](../apps/server/src/discovery/safe-fetch.ts)
pins an approved DNS address while retaining the URL hostname for HTTPS/SNI and
restricts outgoing methods/headers. [Discovery verifier](../apps/server/src/discovery/verifier.ts)
and [delegation](../apps/server/src/discovery/delegation.ts) own authenticated targets.

Cache review spans [server middleware](../apps/server/src/app.ts), body/account
routes, [client hooks](../apps/client/src/hooks.server.ts) and
[mailbox cache](../apps/client/src/lib/mailbox-cache.ts). Existing `no-store` headers
are evidence to inspect, not a completed cross-account cache audit. Filename
validation lives in [codec validation](../packages/hail-codec-ts/src/validation.ts);
[account routes](../apps/server/src/accounts/routes.ts) emit `filename*` and
[shared client API](../packages/hail-client-support/src/account-api.ts) consumes downloads.

**Spec/schema/vector owners.** [Bodies](../spec/bodies.md),
[attachments](../spec/attachments.md), [HTTP binding](../spec/http-binding.md),
[address binding](../spec/address-binding.md), [DID profile](../spec/did-profile.md),
[client API](../spec/client-api.md); attachment declarations in `spec/hail.cddl`
and `spec/vectors/attachments.json`. Header-only changes do not require a signed
schema bump. Add dictionary/header and real TLS fixtures to the owning tests.

**Existing tests and missing proof.** Server `body-retriever.test.ts`,
`body-retrieval-errors.test.ts`, `attachment-routes.test.ts`, `attachments.test.ts`,
`safe-fetch.test.ts`, `address-verifier-delegation.test.ts`; client
`src/lib/mailbox-cache.test.ts`. The transport suite mocks the HTTPS request:
it does not demonstrate rejection of a trusted wrong-host certificate. Add real
transport proof, dictionary limits/malformed/unsupported algorithms, protected
negative-response cache cases and Unicode/reserved/control/path filename cases.

### 2. Envelope and snapshot profile decisions

**Current behavior and reuse.** [COSE implementation](../packages/hail-codec-ts/src/cose.ts)
and profiles authenticate typed CBOR; envelope versions 1–4 serve distinct
consent models. [Admission](../apps/server/src/envelopes/admission.ts),
[receiver](../apps/server/src/envelopes/receiver.ts) and
[PLC envelope authority](../apps/server/src/plc/envelope-authority.ts) own admission
before detached retrieval. [Portable transfer](../apps/server/src/migration/transfer.ts)
and [managed snapshot](../apps/server/src/migration/managed-snapshot.ts) sign a
domain-separated manifest hash and retain exact manifest bytes. Reuse validators,
[cutover gate](../apps/server/src/migration/cutover-gate.ts),
[managed authority](../apps/server/src/migration/managed-authorization.ts) and
history collectors rather than replacing their authority with container validity.

**Spec/schema/vector owners.** [Envelopes](../spec/envelopes.md),
[core delivery](../spec/core-delivery.md), [encoding](../spec/encoding.md),
[transfer formats](../spec/transfer-formats.md), [account history](../spec/account-history.md),
[connection portability](../spec/connection-portability.md), `spec/hail.cddl`,
[history schema](../spec/schemas/account-history-v7-v8.json).
Codec vectors `v0.json`, `threads-v3.json`, `conversations-v1.json` and spec vectors
`portable-history.json`, `managed-history.json`, `transfer-wire.json`,
`connection-history.json`, `conversation-*.json`, `history-negative.json` own
encoding and retained-history evidence.

**Existing tests and missing proof.** TS `cose.test.ts`, `conformance.test.ts`;
Go `codec_test.go`, `threads_test.go`, `conversations_test.go`, `history_interop_test.go`;
server `protocol-interop-vectors.test.ts`, `private-poc-migration.integration.test.ts`,
`managed-network-orchestration.integration.test.ts`, `shared-conversations.integration.test.ts`.
Neither candidate decision is made here. Each needs exact-byte prototypes,
independent verification, size/complexity comparison and a separate adopt/reject
record before implementation or a conditional N/A completion.

### 3. Token plus HTTP-signature retrieval

**Current behavior and reuse.** The body authorization repository already binds
sender, recipient, message, digest, token hash and expiry; the public service
contract returns bytes/missing-body/null, not a recipient-key proof. Extend that
boundary for cheap lookup followed by signature validation before storage-error
disclosure. Reuse the phase 1 retriever and transport, PLC messaging-key resolution,
delivery retry worker and attachment authorization. Transport header allowlists
must deliberately admit signature headers in the new retrieval profile.

**Spec/schema/vector owners.** `spec/bodies.md`, `spec/attachments.md`,
`spec/http-binding.md`, `spec/did-profile.md`, `spec/delivery-state.md`,
`spec/envelopes.md`, and transfer/history documents if authorization records change.
A **planned** retrieval-signature profile and request vectors must define covered
components, key selection, replay/freshness, failure schedule, retry and rotation;
update CDDL only if the chosen envelope negotiation changes signed fields.

**Existing tests and missing proof.** Phase 1 retrieval/error tests and
`attachments.integration.test.ts` are starting points. Add missing/invalid signature
concealment, stolen-token/wrong-recipient/path substitution, bounded valid-token
failures, replay/retry, restart, key rotation and provider-change cases. Existing
bearer retrieval success is not proof of this profile.

### 4. Authentication and authorization

**Phase 4 core implemented.** The [trusted provider integration](../apps/server/src/accounts/provider-authentication.ts)
adds explicit issuer/tenant/subject bindings and locally revocable sessions, with
per-request upstream access checks and no credential delegation. Migration 0110
keeps these records local to the current account generation. The
[contract](../spec/provider-authentication.md) and
[integration tests](../apps/server/test/provider-authentication.integration.test.ts)
cover the existing-application SSO boundary. Production OIDC/SAML connectors and
shared OAuth client access remain unimplemented; the latter is explicitly deferred.

**Current behavior and reuse.** [Passkeys](../apps/server/src/accounts/passkeys.ts)
and [passkey routes](../apps/server/src/accounts/passkey-routes.ts) implement the
custom browser authorization/code exchange. [Account repository](../apps/server/src/accounts/repository.ts)
owns credential/session scope validation; [permissions](../apps/server/src/accounts/permissions.ts),
[account access](../apps/server/src/accounts/access.ts) and
[custody transitions](../apps/server/src/accounts/custody-transition.ts) enforce
separate sensitive-action/owner authority. Reuse these policy services behind the
new contract. Client adaptation owners: [CLI browser login](../apps/cli/src/browser_login.rs),
[CLI credentials](../apps/cli/src/credentials.rs), [GUI authorization page](../apps/client/src/routes/auth/authorize/+page.svelte),
client hooks and [account security](../apps/client/src/lib/server/account-security.ts).

**Spec/schema/vector owners.** `spec/client-api.md`, `spec/account-onboarding.md`,
`spec/managed-custody.md`, `spec/alpha-onboarding.md`, CLI
[contract](../apps/cli/docs/cli-contract.md) and
[credential lifecycle](../apps/cli/docs/credential-lifecycle.md).
Optional OAuth metadata/token/registration schemas and positive/negative request
fixtures are **planned**, not extensions to signed federation CDDL by default.

**Existing tests and missing proof.** Server `browser-authorization.integration.test.ts`,
`passkey-authentication.integration.test.ts`, `passkey-session.integration.test.ts`,
`account-access.integration.test.ts`, `permissions.integration.test.ts`,
`custody-transition.integration.test.ts`; CLI `browser-cases.ts`, `credential-cases.ts`,
`access-cases.ts`. Add independent clients, issuer/audience/redirect/code replay,
refresh/revocation/CSRF and trust-linking cases when implementing the optional
OAuth client-access profile. The phase 4 decision is provider-chosen authentication
with enterprise SSO compatibility; provider-specific clients may use their provider's own
contract. Verify issuer/tenant binding and organizational offboarding independently
of whether the provider offers the shared OAuth client API.

### 5. JMAP synchronization and operations

**Current behavior and reuse.** [Account routes](../apps/server/src/accounts/routes.ts),
[messaging](../apps/server/src/accounts/messaging.ts),
[drafts](../apps/server/src/accounts/drafts.ts), [Trash](../apps/server/src/accounts/message-trash.ts),
[connections](../apps/server/src/accounts/connections.ts),
[Grants](../apps/server/src/grants/service.ts), [conversations](../apps/server/src/accounts/conversations.ts)
and submission/delivery repositories own existing operations. Reuse them behind
JMAP. [Inbox updates](../apps/server/src/accounts/inbox-updates.ts) provides an
account/filter-bound delivery-sequence cursor; it is not a complete change log for
updates/deletes. Client mailbox cache and shared account API own client adaptation.

**Spec/schema/vector owners.** `spec/client-api.md`, `spec/provider-mailbox.md`,
`spec/provider-drafts.md`, `spec/grants.md`, `spec/connection-auth.md`,
`spec/shared-conversations.md`, `spec/delivery-state.md`, `spec/account-history.md`;
`spec/schemas/provider-draft.json`, `content-builder-draft.json`, and the history
schema if export collections change. A **planned** RACR JMAP profile, schemas and
method/state vectors must define actual capabilities and exact signed-byte carriage.
Provider-local JSON vectors are not federation encoding vectors.

**Existing tests and missing proof.** Server `account-api.integration.test.ts`,
`inbox-cursor.integration.test.ts`, `drafts.integration.test.ts`,
`message-trash-routes.test.ts`, `connections.integration.test.ts`,
`shared-conversations.integration.test.ts`; client mailbox-cache and draft tests.
Add two-client convergence, durable tombstones, cursor expiry/reset, concurrent
mutations and durable cross-request submission-idempotency proof.

### 6. Events and Web Push

**Current behavior and reuse.** Inbox updates and phase 5's future durable change
state provide the synchronization seam. No JMAP events/Web Push completion is
claimed. [Delivery statuses](../apps/server/src/delivery/status.ts) remain separate
protocol evidence. Reuse account authorization and safe destination validation,
not browser notification delivery as an acknowledgment.

**Spec/schema/vector owners.** The **planned** JMAP profile owns event/subscription
schemas, lifetime and state-hint vectors; `spec/client-api.md` owns client access,
`spec/delivery-state.md` preserves the hint/evidence distinction. History/transfer
schema changes require an explicit decision about local subscription state.

**Proof to add.** Authorized subscription lifecycle, unsafe destinations, payload
minimization, expiry/revocation, duplicate/lost events, reconnect and bounded retry.
Phase 5 synchronization tests must prove convergence without successful push.

### 7. Publication and interoperability

**Current behavior and reuse.** [Encoding's profile table](../spec/encoding.md),
[spec index](../spec/README.md), [vector index](../spec/vectors/README.md) and
[Internet-Draft workspace](../drafts/README.md) are the publication owners. Reuse
TS/Go consumers and database history exporters; do not label them a full second
provider implementation or the draft an adopted standard.

**Spec/schema/vector owners.** All profiles changed by earlier phases, their exact
schemas and vectors, plus draft source/renderings when its snapshot is advanced.
Registration templates/allocation policy and independent-client/provider evidence
are **planned**. The initial inventory below precedes final names and submissions.

### 8. MLS conversations

**Current behavior and reuse.** Current body validation, content builder, provider
messaging, conversation membership and attachment/history services operate on the
existing content model. Reuse consent and delivery boundaries; there is no MLS
profile or client-held epoch/device state defined by this baseline.

**Spec/schema/vector owners.** `spec/shared-conversations.md`, `spec/bodies.md`,
`spec/assets.md`, `spec/attachments.md`, `spec/envelopes.md`, `spec/did-profile.md`,
`spec/account-history.md`, custody/recovery specifications and both codecs.
Encrypted body, device/epoch and history-access schemas and vectors are **planned**.
Existing conversation/body/transfer tests are regression coverage only; add
multi-device/offline/removal/state-loss/recovery/migration and malicious-provider
threat cases before claiming encrypted-profile interoperability.

## Cutover requirements by phase

These are acceptance constraints for later release plans, not invented wire-version
numbers or operational migration scripts. All rows inherit the shared preservation
rules above; unresolved profile choices must be resolved before that phase ships.

| Phase | Cutover and preservation requirement |
| --- | --- |
| 0 | Documentation only; no account, history, custody or runtime migration. |
| 1 | Deploy parsing/transport fixes without rewriting signed bodies or tokens. Preserve coded versus decoded integrity domains, failure concealment, availability and authenticated discovery freshness. Determine malformed/unsupported dictionary behavior before publishing parser vectors. |
| 2 | Decide envelope and snapshot adoption separately. If adopted, switch writers/readers and peers at an explicit profile boundary; retain original authenticated history as evidence, not silently converted authority. Keep all current consent models. Regenerate current-format vectors deliberately. Drain or explicitly reject/restart in-flight incompatible transfers while retaining fences and owner/destination checks. Reject obsolete input rather than maintaining an indefinite dual writer. If rejected, record reasons and mark only the candidate's conditional work N/A. |
| 3 | Coordinate recipient clients/providers and sender authorization storage before enabling mandatory signatures. Specify applicability to existing tokens and outstanding availability commitments; no silent bearer fallback. Preserve recipient/message/digest binding and transfer of pending retrieval authority. Define replay-state persistence and retry behavior across restart and key/provider changes before rollout. |
| 4 | Provider-owned authentication and enterprise SSO are the core contract; the shared OAuth API is optional. If replacing the custom client exchange, keep DIDs, account IDs, custody evidence and enrolled provider credentials; explicitly invalidate obsolete custom codes/sessions/API tokens and require reauthorization as needed. Define credential classification and GUI/CLI upgrade steps before removal. Never reinterpret an old token as OAuth, copy a passkey to another origin, or equate login with independent owner authority. Provider transfer requires explicit audience/issuer rebinding and reauthorization, not forwarding old credentials. |
| 5 | Introduce JMAP over existing account/domain services. Define stable IDs and a starting state, then capture creates/updates/deletes durably before clients rely on changes. Explicitly reset old cursors/caches and resynchronize. Preserve signed bytes, local read/Trash/draft state and pending sends; reconcile or drain sends before changing retry keys. Decide transfer reset versus continuity and local-state export coverage before schema changes. |
| 6 | Enable only after phase 5 sync is usable. Bind subscriptions to current account/client authority; revoke on loss of access. Recreate or explicitly reauthorize subscriptions after provider transfer, never copy endpoint credentials blindly. Lost notifications require sync, not read-state or delivery-status changes. |
| 7 | Finalize provisional names before profile stability; any signed name change follows phase 2's byte/history cutover and regenerates both codec vectors. Record actual registration status. No cleanup, account migration or compatibility guarantee follows from publication alone. |
| 8 | Introduce an explicit encrypted profile/epoch boundary; retain existing authenticated history in its original form. Do not claim retroactive confidentiality. Preserve account/custody authority while defining separate device enrollment, epoch secrets, history access and recovery. Determine plaintext draft/search/cache cleanup and attachment/deduplication changes explicitly; provider migration must not transfer client secrets as provider custody. |

## Initial media-type and extension inventory

This inventories existing values and candidate allocation surfaces, not completed
registration templates. Values called provisional in the current spec remain so.

| Surface | Existing owner/value | Phase dependency |
| --- | --- | --- |
| COSE wrapper | `application/cose; cose-type="cose-sign1"`; protected labels 1/3/4 in `spec/encoding.md` and TS/Go COSE | Reuse existing container allocations; phase 2 decides any revised hash-envelope profile and extension labels. |
| Protected content types | `application/hail-{address-binding,sender-profile,grant,envelope,delivery-status,connection-invitation,connection-confirmation,connection-control,conversation}+cbor` (brace notation lists nine individual strings) | Exact strings are signature-domain inputs; phase 2/7 must coordinate changes. |
| Historical codec profile | `application/hail-connection-grant+cbor` remains in TS profiles | Distinguish retained evidence from required current creation; do not register obsolete formats merely because a reader exists. |
| Body and transfer HTTP types | `application/hail-body+cbor` in body service/codec; `application/hail-transfer+json` in migration wire | Phase 1 retains current body identity; phases 2/8 may revise profiles. |
| Signature domains outside COSE | `hail-migration-snapshot-v7\0` / `v8\0`; handshake, consent, activation, monitor and checkpoint domains inventoried in `spec/transfer-formats.md` and `spec/account-history.md` | Phase 2 must account for snapshot domains; unrelated authority domains are not implicitly replaced. |
| Discovery and identity | WebFinger relations and DID fragments/service endpoints in `spec/address-binding.md` and `spec/did-profile.md` | Retain authenticated federation discovery; phase 4/5 adds client discovery separately. |
| Closed object/profile identifiers | `hail.*`, SPT profiles and envelope versions in `spec/hail.cddl` and codec profiles; reference account `racr.*` in `spec/client-api.md` | Phases 2/5/8 define extension/negotiation policy before adding values; no silent signed-schema normalization. |
| New standards surfaces | OAuth issuer/resource metadata and scopes; RACR JMAP capability/type IDs; retrieval-signature profile; MLS device/content identifiers | Names and allocation policies remain open in phases 3–8. Prefer appropriate existing allocations/domain-controlled identifiers; no private COSE label assigned here. |

## Baseline validation and limits

Phase 0 is complete when the inventory and cutover matrix are linked from the
checklist, local paths resolve, and representative existing boundary tests have
been exercised with their results recorded here. This does not complete phase 1
or establish standards conformance. Database integration, production behavior,
independent OAuth/JMAP clients and real TLS certificate tests remain later gates.

Local evidence on 2026-11-10 (working tree based on `2bf1a8b`):

```sh
bun run --cwd packages/hail-codec-ts build
bun run --cwd apps/server test -- test/body-retriever.test.ts test/body-retrieval-errors.test.ts test/safe-fetch.test.ts test/attachment-routes.test.ts test/protocol-interop-vectors.test.ts
mise exec -- go -C packages/hail-codec-go test -run 'Test(AccountHistory|TransferWire|ConnectionWire)Interoperability|TestPublishedHistoryRejections' ./...
git diff --check
```

Codec build passed; all 75 tests in the five selected server suites passed;
selected independent Go interoperability/rejection tests passed. Local Markdown
targets were checked for existence. No runtime, schema or vector bytes changed;
no database suite or production rollout was performed. Phase 1's first concrete
implementation is the bounded Content-Digest dictionary parser, with the separate
coded-byte and signed-body checks preserved.
