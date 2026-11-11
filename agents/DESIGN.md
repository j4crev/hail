# RACR Protocol Concept Design Notes

This document is a nonnormative design overview. The files under [`../spec`](../spec) are authoritative where they differ. Sections explicitly labeled as future direction are not part of v0.

RACR Protocol is a federated, permission-based messaging concept intended to solve the downfalls of email by changing the default delivery model and strengthening sender identity, message authorization, deliverability, and client-side safety.

## Goals

- Prevent spam by default rather than filtering it after receipt.
- Support safe, rich messages.
- Allow federation between independently operated servers.
- Support user choice of providers and clients.
- Support portable identities for users and organizations with provider-issued or custom-domain addresses.
- Make sender authenticity visible at the consent moment, not hidden in technical headers.
- Use open standards where practical.
- Implementation should be approachable by hobbyists and independent developers.
- Explore future email-client and email-bridge integration without making it part of the v0 federation protocol or weakening Hail's authorization model.

## v0 Scope

v0 should focus primarily on B2C communication such as:

- newsletters
- receipts
- bookings
- account notifications
- promotions
- security alerts
- support replies to solicited messages

This is closer to consent-based business/customer messaging than a full replacement for all email conversations.

The core delivery design covers:

- sender discovery
- receiver-created grants
- cheap rejection of unauthorized traffic
- signed message envelopes
- detached body retrieval by hash
- category-scoped subscriptions
- reply capabilities
- revocation behavior

## Non-Goals For v0

- Replacing all email use cases immediately.
- Solving provider-owned address portability.
- Building a Hail-specific global identity registry. Hail uses the external PLC registry and its verifiable operation log.
- Supporting unsolicited messages.
- End-to-end encryption.
- A complete rich block-document vocabulary.

## Identity Model

Hail uses DIDs as durable protocol identities and email-like addresses as human-readable aliases:

```text
alice@example.com
```

The address resolves to a DID. Grants, envelopes, and durable relationships bind to DIDs rather than addresses or provider endpoints.

Hail addresses are case-insensitive and serialize in lowercase canonical form. The strict public-federation profile permits an ASCII LDH-style local part of at most 63 bytes and an IDNA2008 A-label public DNS domain, subject to label, Public Suffix List, and 254-byte total limits. Bare public suffixes, special-use or unknown suffixes, root dots, quoted local parts, domain literals, and internationalized local parts are excluded. [`../spec/address-binding.md`](../spec/address-binding.md) is authoritative for the complete syntax and `acct:` URI mapping.

v0 distinguishes receiver onboarding requirements from sender verification requirements.

Receivers may use provider-issued Hail address aliases, especially if they only receive messages:

```text
alice@provider.example.com
```

All identities use `did:plc` as their durable identity. A provider-issued Hail address is an alias and may change when the user migrates, while the DID and grants remain stable.

A custom-domain address may provide a stronger user-visible organizational signal, but v0 permits either provider-issued or custom-domain sender addresses:

```text
updates@store.example.com
receipts@airline.example.com
```

For v0, portability of the human-readable Hail address itself is available to users and organizations that control their own domain:

```text
alice@alice.example.com
updates@store.example.com
```

Custom-domain identities also use `did:plc`. Their domain-backed Hail address can remain stable across hosting-provider migration if the domain continues publishing a valid binding to the same DID. Loss, transfer, or withdrawal of that binding can make the address unverified without transferring or revoking DID-bound grants and history.

A provider may later offer managed personal-domain registration and DNS as a paid service. This is optional rather than a baseline requirement because every user would otherwise incur domain registration and renewal costs. For meaningful portability, the user should be the registrant or otherwise have a guaranteed right to transfer the managed domain away from the provider.

## Portable Identity

A DID is the durable identity anchor. The Hail address is a human-readable, replaceable alias, and the hosting endpoint is mutable infrastructure delegated through the DID.

The intended resolution chain is:

```text
human address -> DID -> current Hail service endpoint and verification keys
```

Address-to-DID resolution uses a nonexpiring Hail Address Binding discovered through authenticated HTTPS WebFinger at the address domain. The WebFinger response selects one binding using the exact `https://racrproto.com/rel/address-binding` relation, and the selected binding separately verifies under the DID's `#hail-identity` key. Discovery follows the bounded redirect, SSRF, media-type, issuance-time, and one-hour maximum-cache rules in [`../spec/address-binding.md`](../spec/address-binding.md). Hail addresses are not written to `alsoKnownAs`, avoiding permanent address history in the public PLC log.

Continuity-preserving provider migration fences the old provider, transfers the complete grant, reply, replay, delivery, status, cache-provenance, and verification-evidence serialization domain, then updates both `#hail-messaging` and `#hail`. The new provider starts only after durable import and after the PLC update satisfies the [current read-evidence policy](../spec/plc-read-evidence.md). The DID and DID-bound relationships remain stable.

For domain-backed sender addresses, authenticated WebFinger publication proves that the domain authorizes the address-to-DID association. Direct DNS proof is not part of v0. Hosting that DID's Hail service does not itself make a provider the identity owner.

Hail supports `did:plc` for individuals and organizations, whether their address is provider-issued or under a custom domain. The published PLC specification permits application-specific verification methods and services. Hail implementations access PLC through a configurable resolver boundary so caching, mirrors, audit verification, and alternative directory infrastructure do not affect protocol objects.

## Hail DID Profile

A Hail-capable DID exposes two distinct verification methods and one service entry:

```text
#hail-identity   Signs Hail Grants and Hail Address Bindings.
#hail-messaging  Signs Hail Envelopes (including replies), Sender Profiles,
                 and Hail Delivery Status snapshots.
#hail            Locates the current Hail server.
```

The identity and messaging roles use separate keys. This allows a provider to operate routine messaging without automatically receiving authority to create grants or address bindings for the user.

The `#hail` service has type `HailMessaging` and one HTTPS base endpoint. Standard server-to-server paths are derived from that base URL.

PLC operations store both Hail keys as named Ed25519 `did:key` values and store the Hail service as a named string endpoint. Resolvers expand relative IDs in PLC-rendered DID documents before validating the exact key roles, controllers, service type, and endpoint.

Provider migration updates `#hail-messaging` and `#hail` through a PLC operation while preserving the DID and `#hail-identity`. Operational continuity additionally requires the fenced state-transfer procedure described above. PLC rotation keys remain separate from both Hail keys.

The complete profile is defined in [`../spec/did-profile.md`](../spec/did-profile.md).

### PLC Operational Consequences

Using PLC for every identity establishes one recovery and resolution model, but also makes several constraints universal:

- Every account needs PLC rotation-key management using P-256 or secp256k1 in addition to Hail's Ed25519 signing keys.
- Hail consumes two of PLC's maximum ten verification-method slots; an existing PLC identity needs two free slots before it can enable Hail.
- Every identity and provider migration depends on PLC directory availability, so production servers need validated mirrors or local log replication.
- PLC updates are full state snapshots. Key rotation and provider migration tooling starts from validated current state and preserves unrelated keys and services rather than patching one field. Every existing non-Hail `alsoKnownAs` value and its order are preserved unless the DID controller explicitly authorizes an alias change in the exact signed update.
- PLC's 72-hour higher-authority recovery window can reverse a lower-authority update. Hail must define when new keys and endpoints become authoritative before production migration is safe.
- PLC rotation keys act unilaterally rather than by threshold. A user-held higher-priority key protects a provider-held update key only if unauthorized changes are detected and recovered within 72 hours, so monitoring is part of the recovery model.
- Verification keys, service endpoints, update timestamps, nullified operations, and tombstones are permanently public. Hail addresses stay in expiring Address Bindings and out of PLC state.
- Custom-domain control authenticates the human-readable address, while PLC rotation authority independently controls the durable identity. Losing or transferring the domain does not transfer DID-bound grants or message history.

## Account Onboarding

Creating a provider-local account, registering a DID, and publishing a Hail address are separate steps. Public Hail v0 DIDs submit their signed PLC operations to `https://plc.directory`; implementations may resolve the resulting canonical log through validated mirrors or local replicas. A local PLC directory is suitable for an isolated development network, but a DID registered only there is not a public-federation Hail identity because the DID itself contains no registry or network identifier.

Production providers must support portable custody. The user controls the top-priority PLC recovery key and `#hail-identity`; the provider controls a lower-priority PLC rotation key and `#hail-messaging`. User private keys are generated client-side, recoverable through an encrypted provider-independent backup, and unavailable in plaintext to the provider. A password alone is not sufficient protection for provider-accessible backup ciphertext.

An accepted operation from the provider's lower-priority PLC key becomes current immediately and can remove the user's keys; the user's higher-priority key can nullify it only during PLC's 72-hour recovery window. Each production account therefore configures a continuously operating PLC monitor outside the provider's administrative control that detects changes within 24 hours and alerts the user through an out-of-band channel.

For a new identity, the client validates and signs the exact full genesis `plc_operation`, both sides derive the DID, the provider submits it, and the client and provider verify the registered operation and resulting state. A user may instead bring an existing `did:plc`; onboarding publishes a user-authorized full-state update that preserves unrelated entries and adds the provider below every user recovery key. An existing active Hail identity uses the provider-migration flow rather than ordinary onboarding.

Address publication occurs only after the expected DID state resolves. The immutable signed Address Binding is staged first, WebFinger selects it second, and the provider activates the account only after complete address-to-DID and DID-to-service verification. Ambiguous PLC submissions reuse and look up the already-derived DID rather than generating another genesis operation. PLC registration is permanent and is never rolled back by automatically tombstoning a failed onboarding attempt.

An isolated POC may use disclosed provider custody and a local PLC directory, but it does not conform to the production portable custody profile. The complete lifecycle, failure states, retained evidence, and existing-DID procedure are defined in [`../spec/account-onboarding.md`](../spec/account-onboarding.md).

## Sender Discovery

QR codes, application search, curated directories, and recommendations are entry points rather than identity authorities. They yield a Hail address that the client treats as untrusted until verification.

The grant-discovery chain is:

```text
Hail address
  -> signed Address Binding
  -> did:plc identity
  -> PLC-discovered Hail service and #hail-messaging key
  -> signed Sender Profile with embedded categories
```

The profile is retrieved from `GET {hail-service-base}/profiles/{sender_did}`. It is DID-scoped so one signed profile works with multiple independently verified addresses for that DID. The client displays the separately verified address alongside the profile rather than allowing profile metadata to claim an address.

Sender Profile v1 contains a display name, optional description, stable category IDs with labels and
descriptions, revision, update time, and signer key. V2 may add one bounded,
digest-bound bundled PNG avatar; remote assets, subscriber data, and
recipient-specific state remain excluded. Profiles form a monotonic DID-scoped
revision sequence; category IDs must not be repurposed, and profile changes do
not alter existing grants. New consent requires a profile verified against
sufficiently fresh current PLC state. The complete profile is signed by
`#hail-messaging`, and its representation digest is retained in every grant's
required consent context.

Search and QR encoding remain application-specific. A forged or stale search result cannot authorize a sender because the client independently verifies the Address Binding, PLC state, profile DID, and profile signature before consent.

## Consent-Time Sender Address Verification

For v0 consent, the visible sender address and profile are anchored jointly to the address domain's WebFinger publication, the DID-signed Address Binding, and the PLC-authorized profile key.

A sender claiming `updates@store.example.com` must have that address domain publish its Address Binding, and the binding and Sender Profile must verify under the same PLC identity.

This does not fully solve lookalike domains such as `example-store-security.com`, but it gives users and clients a concrete verified domain to inspect during the grant flow.

After grant creation, routine delivery authorization uses the grant and envelope DIDs. Delivery authenticates `from` through its current `#hail-messaging` key and does not transfer or re-evaluate a grant based on current address resolution.

Possible later mitigations:

- domain age display
- organization verification
- transparency logs
- trust registries
- verified brand relationships
- warning UX for newly registered or deceptive domains

## Hail Grants

A Hail Grant is a recipient-created, recipient-signed authorization from one DID to another. The recipient server is authoritative, and the sender cannot create or expand consent on the recipient's behalf.

v0 permits at most one active grant for a grantor/grantee DID pair and supports exactly one nonempty categories scope selector. Every revision carries consent context committing to the verified Address Binding and Sender Profile shown during consent. A revision that adds or replaces an authorized category, requires fresh evidence and explicit opt-in; merely adding a category to a Sender Profile grants nothing. Restrictions and revocation preserve prior evidence and never depend on sender availability. Unknown scope types fail closed. Revocation is terminal for that grant ID, while expiration is nonterminal and may be renewed by a higher valid revision. A `grant_id` is only a lookup hint, never a bearer capability.

The complete grant schema, scope semantics, lookup rules, revision lifecycle, and HTTP publication behavior are defined in [`../spec/grants.md`](../spec/grants.md).

## Message Types

Message types allow clients to render and organize messages more intelligently than email.

When present, `message_type` must use one of these exact closed v0 values:

- personal
- newsletter
- promotion
- receipt
- invoice
- ticket
- boarding-pass
- account-alert
- security-alert
- package-update
- calendar-event

Message type and category are related but not identical.

Category is sender-defined consent scope. Message type is protocol-defined presentation metadata; it grants no authority and is not a grant selector.

## Detached Hail Body Delivery

Hail Messages should use a small signed Hail Envelope with a detached Hail Body.

The complete immutable body must exist before envelope submission. The envelope is delivered first, and the recipient server retrieves or reuses the body only after authorizing the envelope.

Benefits:

- unauthorized traffic can be rejected before parsing large bodies
- signatures can be checked over compact metadata
- one body can be reused for many recipients
- recipient servers can deduplicate underlying storage by content hash without exposing cross-recipient cache membership
- future asset profiles can preserve independent authorization, caching, and verification
- remote tracking pixels become avoidable by design

V0 uses one content-addressed body for any number of byte-identical messages, plus a separate recipient-specific retrieval token in each signed envelope. Each envelope commits to availability for at least 30 days after its signed `created_at`; a shared body and each recipient-specific authorization remain available through the latest applicable signed `available_until`. Exact hashing, token, retrieval, caching, compression, integrity, and retention rules are defined in [`../spec/bodies.md`](../spec/bodies.md).

## Hail Envelope

The envelope is compact and carries only data needed for routing, authorization, presentation, threading, and body retrieval.

v0 uses one recipient per envelope, UUIDv7 message IDs scoped by sender DID, grant or reply authorization, required timestamps, and explicit reply behavior. The envelope signature covers a closed detached-body descriptor containing the digest, uncompressed size, media type, profile, availability commitment, and recipient-specific bearer authorization. The payload uses deterministic Hail CBOR in tagged COSE_Sign1 signed with the sender's `#hail-messaging` key and the RFC 9864 fully specified COSE `Ed25519` algorithm. POC limits include a 16,384-byte signed representation, a 256 KiB uncompressed body, 300 seconds of timestamp tolerance, and an envelope expiration no more than seven days after creation.

The complete schema, signature profile, validation order, and replay behavior are defined in [`../spec/envelopes.md`](../spec/envelopes.md). Detached body behavior is defined in [`../spec/bodies.md`](../spec/bodies.md).

## Delivery State

`accepted` means the recipient server authenticated and authorized the envelope, fixed its authorization, and durably assumed responsibility for body processing. A later grant change prevents future acceptance but does not cancel an already accepted envelope.

`delivered` means the recipient server verified the body and durably stored the accepted envelope, recipient-specific message record, and either the body bytes or a durable reference to their verified content-addressed copy. It does not mean that a client synchronized, displayed, opened, or read the message.

Retry scheduling belongs to the recipient server until the earliest of `expires_at + 300 seconds`, `body.available_until`, and `body.access.expires_at`, using bounded backoff and jitter. Sender-visible state uses `accepted`, `on-hold`, `delivered`, `failed`, and `cancelled`, with state-specific reason codes. The current signed state may be returned synchronously to an eligible authenticated sender. v0 asynchronously pushes every terminal `delivered`, `failed`, or `cancelled` snapshot, but does not push `accepted` or `on-hold` snapshots.

For a logical message sent to many recipients, each recipient envelope has its own message ID and delivery state. Campaign grouping and aggregate counts remain local to the sender; byte-identical recipients may still share one body digest.

The complete state machine and status object are defined in [`../spec/delivery-state.md`](../spec/delivery-state.md).

## Replies

Replies are authorized by prior messages, not by standing grants in the reverse direction.

When an envelope permits replies, the original sender retains an authenticated sent-message record proving the signed reply permission. The message ID reference is a lookup hint, not a transferable bearer capability.

When the recipient sends a reply, `authorization.reply_to` points at the original message. The original sender's server accepts one next message only if it previously sent that message with replies allowed and the reply is still within `reply.until`. The capability is atomically claimed during acceptance and consumed by completed delivery. Terminal failure or cancellation releases the claim for one replacement before the deadline; an idempotent retry retains the same claim.

Suggested product default:

```text
120 days
```

The protocol has no implicit default. `reply.allowed: true` requires an explicit signed `reply.until`; products may suggest a 120-day value and senders may choose a different deadline.

The POC applies the common 256 KiB maximum uncompressed body size to replies and defines no reply-specific minimum. Sender Profiles do not advertise sender-specific reply-size or attachment limits; assets and attachments are unsupported by the POC body profile.

v0 deliberately permits one next message per capability. Multiple conversational turns form a linear chain in which each delivered reply may grant one further reply. Either side can end the thread with `reply.allowed: false`; sibling replies require a future authorization design.

## Revocation

Revocation is local and unilateral.

The recipient server enforces a signed revoked grant revision immediately and notifies the sender asynchronously. The sender does not approve revocation, and notification failure cannot delay it.

Current address-to-DID discovery and DID routing are public. To prevent probing of grants, replies, replay records, message state, local-account state, recipient policy, cache state, and user activity, protected failures use the generic `202`/`received` response until the sender signature is verified and local state confirms a current or previous grant or reply relationship. Only then may privacy policy permit detailed outcomes such as revoked grant or ungranted category.

Grant revocation is defined in [`../spec/grants.md`](../spec/grants.md). Revocation wins if it commits before envelope acceptance; acceptance wins if it commits first. Delivery state is defined in [`../spec/delivery-state.md`](../spec/delivery-state.md).

## Hail Body Format Strategy

V0 does not depend on arbitrary HTML as the rich message format.

The POC retains the fixed plain `spt-1` schema, adds `spt-2` rich text with
headings, lists, basic decorators and declared HTTPS links, and adds `spt-3`
with one digest-bound bundled PNG header. These closed deterministic-CBOR
profiles make unsafe behavior inexpressible instead of relying on sanitization
after parsing untrusted markup.

Use the exact examples and constraints in [the body specification](../spec/bodies.md).
Additional semantic blocks, themes and
layouts require an explicit profile design rather than arbitrary editor extensions.

Connection messages use explicit connection authorization; subscription replies
retain their single-use capabilities. Signed version-3 parent references establish
thread relationships without broadening either permission. See [envelopes](../spec/envelopes.md).

## Rich Content And Assets

The v1 asset manifest defines bounded, non-animated bundled PNG bytes with
SHA-256 integrity, dimensions, size, role and loading mode. `spt-3` uses one
`header` asset and prohibits remote resources, so rendering cannot disclose a
user open to the sender. Sender Profile v2 uses the same manifest for bundled PNG avatars. Attachments, remote assets,
and other image formats remain deferred. See
[content storage and attachments](content-storage-and-attachments.md) for
the received-body storage implementation and attachment design constraints.

Later profiles may package additional declared assets or structured metadata.

Every bundled or future external resource needs a manifest entry with:

- asset id
- content type
- byte size
- hash
- dimensions, where relevant
- role, such as `preview`, `logo`, or `attachment`
- loading mode

Possible future asset loading modes:

- bundled
- deferred
- remote, only if declared and controlled by client/server policy

Remote assets would remain optional from the user's perspective. Clients and recipient servers could block, proxy, prefetch, or cache them according to user policy.

Future body content should not reference arbitrary external resources. It should reference declared assets instead.

Example:

```text
spt-asset:hero
```

## Encoding And Compression

The logical message model is deliberately JSON-shaped, but the sole authoritative v0 federation representation for Hail-owned objects and bodies is deterministic CBOR. Application developers may use diagnostic JSON, generated models, or provider-local JSON APIs without implementing the wire codec.

POC detached-body transfer uses `application/hail-body+cbor` and permits either an unencoded response or optional gzip transport compression:

```text
Content-Type: application/hail-body+cbor
Content-Encoding: gzip  # optional
```

The signed body digest and size cover exact uncompressed deterministic body bytes, regardless of transport coding. Signed objects use tagged COSE_Sign1 and are not HTTP-compressed. Their outer media type is `application/cose; cose-type="cose-sign1"`; the protected COSE content type identifies the exact embedded Hail object. WebFinger, rendered DID documents, Problem Details, and generic receipts retain their externally defined JSON representations. Zstd remains a separate future body-transfer decision.

The shared codecs, schemas, typed models, diagnostic converters, and conformance vectors keep CBOR and COSE mechanics out of ordinary application code. Hail follows the constrained-data-model precedent of DRISL and AT Protocol where useful but does not require AT Protocol interoperability, CIDs, CAR files, or repository structures.

## Signatures

v0 defines exactly five signed object profiles:

| Object | Protected content type | Required key role |
| --- | --- | --- |
| Hail Address Binding | `application/hail-address-binding+cbor` | `#hail-identity` |
| Hail Sender Profile | `application/hail-sender-profile+cbor` | `#hail-messaging` |
| Hail Grant | `application/hail-grant+cbor` | `#hail-identity` |
| Hail Envelope, including replies | `application/hail-envelope+cbor` | `#hail-messaging` |
| Hail Delivery Status | `application/hail-delivery-status+cbor` | `#hail-messaging` |

Any additional signed object type requires an explicit future schema, protected content type, and key-role definition.

The Hail Envelope v0 profile uses:

- deterministic Hail CBOR
- tagged COSE_Sign1 with embedded payload
- the RFC 9864 fully specified COSE `Ed25519` algorithm value `-19`
- the sender DID's `#hail-messaging` key

The common profile is defined in [`../spec/encoding.md`](../spec/encoding.md), and envelope-specific rules are defined in [`../spec/envelopes.md`](../spec/envelopes.md). Every signed object has an exact protected content type and key role so types remain domain-separated.

Deterministic encoding produces exactly one accepted byte representation before signing or hashing. Receivers reject alternate valid-CBOR spellings to prevent ambiguous signatures, digests, and replay identities.

Digest domains remain distinct:

| Purpose | SHA-256 input |
| --- | --- |
| Address Binding, Sender Profile, and Grant revision digest | Complete tagged signed COSE representation bytes |
| Envelope replay and Delivery Status correlation | Deterministic envelope payload bytes, excluding COSE |
| Body content identity | Exact uncompressed deterministic body bytes |

## Server-To-Server Delivery

The `#hail` DID service publishes an arbitrary validated HTTPS base path. v0 appends these fixed relative operations:

```text
GET  {base}/profiles/{sender_did}
PUT  {base}/grants/{grant_id}
POST {base}/envelopes
GET  {base}/bodies/{digest}
PUT  {base}/deliveries/{envelope_digest}
```

Replies reuse `POST {base}/envelopes` as normal messages with reply-based authorization. v0 defines no `QueryDeliveryStatus` method or path. Federation clients do not follow redirects; selected network, redirect, endpoint, or refreshable key failures trigger one PLC refresh and retry only at a changed authenticated endpoint.

| Operation | Key transport behavior |
| --- | --- |
| Retrieve Sender Profile | Public `GET`; `200` or `304`, strong ETag, and at most one hour of cache freshness |
| Publish Grant Revision | Conditional `PUT` using `If-None-Match` or `If-Match`; successful create/update uses `201` or `204` |
| Submit Envelope | Signed COSE `POST`; protected outcomes use generic `202`, while eligible authenticated success may return `200` with signed status |
| Retrieve Body | Bearer-authorized `GET`; uniform `404` for protected absence/authorization failures, with retryable `429` and `503` |
| Push Delivery Status | At-least-once terminal-status `PUT`; only `204` acknowledges receipt, while generic `202` is not an acknowledgement |

Detailed errors use RFC 9457 `application/problem+json` only when disclosure policy permits. Signed COSE objects use no HTTP content coding.

High-level delivery flow:

1. The sender resolves the recipient's address binding to a DID when necessary, then resolves that DID's current Hail service.
2. The recipient applies transport-size, bounded CBOR/COSE, closed-schema, and inexpensive field checks to the submitted envelope.
3. Claimed fields may support only a preliminary local grant or reply lookup whose result is not externally distinguishable and reveals no relationship state.
4. The recipient resolves current DID keys, verifies COSE, and binds the authenticated sender and recipient.
5. It atomically checks `(from, message_id)` and either returns the stored result or reserves a pending authenticated replay record before final policy and authorization checks.
6. It applies policy, then atomically rechecks grant category scope or reply authority, claims any reply capability, and creates `accepted`; otherwise it stores the authenticated rejection.
7. After acceptance, the recipient retrieves the body with the signed bearer authorization, or reuses a verified cache entry with matching recipient-and-sender provenance.
8. The recipient verifies body bytes and commits exactly one terminal delivery outcome.

Protected outcomes remain a generic `202`/`received` unless the sender is authenticated, has current or previous local relationship state, privacy policy permits detail, and processing completes within the bounded response schedule. Eligible success returns `200` with signed Delivery Status; eligible explicit failures use Problem Details. Envelope transport ambiguity, generic receipt, `429`, and `503` permit byte-identical retries with the same message ID. After acceptance, body retries belong to the recipient. Terminal-status pushes use the fixed jittered schedule and continue until acknowledged or permanently rejected as defined in [`../spec/http-binding.md`](../spec/http-binding.md).

## Unsolicited Messages

V0 should not support unsolicited messages.

Unknown senders may eventually be allowed to send constrained contact or subscription requests, but those requests should be small, plain, rate-limited, and free of rich content or arbitrary links.

## Privacy And Analytics

HTTP receipt, Hail envelope acceptance, and completed delivery are separate. The generic `202` response proves only receipt. An eligible authenticated exchange may instead return a signed current status or detailed Problem Details without changing that distinction. Acceptance and delivery status do not imply that a person opened or read the message.

Read/open receipts are not part of v0. Any future read-receipt protocol would require separate explicit recipient consent and must prevent covert mechanisms such as tracking pixels.

Possible analytics model:

- delivery status is protocol-level
- future read/open receipts require explicit opt-in
- aggregate campaign stats may be computed by the sender from per-recipient delivery statuses
- per-user surveillance should not be built into the protocol

The pitch to legitimate senders is better deliverability and more honest engagement data in exchange for reduced covert tracking.

## Reference Architecture

The TypeScript provider owns account APIs, federation handlers, durable workers
and transactional delivery/transfer state. The browser client and `racr` use
its account API; independent providers interoperate through the federation
specifications. TypeScript and Go codecs share conformance vectors.

Current behavior and operational entry points are documented in the
[root README](../README.md), [provider guide](../apps/server/deploy/public/README.md)
and [CLI workflows](../apps/cli/docs/cli-workflows.md).

## Open Questions

Current PLC authority and recovery rules are defined in [the DID profile](../spec/did-profile.md)
and [read-evidence policy](../spec/plc-read-evidence.md).

- What production uncompressed body size must every conforming server accept, and what recipient-configurable ceiling is permitted?
- How should organization verification work beyond domain control?
- How should bridge-to-email work without weakening the anti-spam model?

## Topics To Discuss Next

- Production body-size interoperability floors and ceilings.
- Server abuse protections and rate limits.
- Email bridge strategy.
- Business model and ecosystem incentives.

## Standards adoption direction

Status: Accepted direction with explicitly marked design decisions still open,
2026-11-10. Nonnormative; implementation is tracked in the checklist below.
This section does not change current wire formats. Every implementation updates
its affected `spec/` documents, schemas, version inventory and conformance vectors
in the same change. Pre-launch changes need not preserve superseded alpha formats;
preserve authenticated current history and define an explicit cutover instead.

The intended layers are provider-chosen authentication, optional OAuth client
authorization, JMAP client/provider
interoperability, RACR recipient consent and federation, and eventual MLS content
encryption. Reusing a standard is a valid interoperability benefit even when the
current implementation already provides similar behavior. Evaluate security,
implementation burden and ecosystem compatibility, not just new features.

### Retrieval tokens and HTTP signatures

Retain recipient-specific bearer tokens for cheap rejection and add mandatory
[RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
in the current retrieval profile. The token selects a current authorization record;
the signature proves possession of the authorized recipient's messaging key.
Neither alone permits retrieval in that profile. This limits token-leakage damage
without forcing unauthenticated requests through expensive PLC/key verification.

The [body repository](../apps/server/src/bodies/repository.ts) already records
recipient DID and message ID. Perform bounded token/digest/status/expiry lookup
before resolving the record's recipient key. A valid token is not permission to
choose an arbitrary DID or key-resolution URL. Rate-limit even valid-token
failures: a leaked token still permits attempts at expensive verification.

The [implemented retrieval profile](../spec/retrieval-signatures.md) defines the
signed method, target and Authorization field, freshness, replay state and
rotation/migration behavior. Failures stay concealed until both proofs pass;
a valid token with a missing/invalid signature receives the same generic response.
No bearer-only fallback is supported. HTTPS, immutable
body digest checks and availability commitments remain necessary.

### RFC 9995 envelope and transfer evaluation

[RFC 9995](https://www.rfc-editor.org/rfc/rfc9995.html) does provide the ability to
verify a signature over a content hash without retrieving the original content.
The current envelope already uses the RFC 9052 COSE_Sign1 container; RFC 9995
would standardize its hash-envelope structure further. It does not define RACR
parties, recipient consent, categories, conversation membership or availability.
Those semantics still require a RACR profile whichever container is selected.

Evaluate replacement of ordinary envelopes as well as the bespoke
[transfer-manifest signature wrapper](../spec/transfer-formats.md#snapshot-profile-and-standardization-boundary).
Existing implementation effort is not a reason to reject replacement. RFC 9995
requires a hash payload and forbids header label 3, which Hail currently requires;
its adoption needs a deliberately revised profile rather than optional headers
on the old format.

For ordinary delivery, compare a body-hash envelope with authenticated RACR
metadata in explicitly defined protected headers against a hash of a complete
RACR descriptor carried alongside its preimage. These are candidate designs, not
approved wire formats. Show exactly how all admission metadata is authenticated
without downloading the body first. Do not imply application-specific metadata
becomes standardized merely by putting it in a COSE header. Define extension
labels/registration, domain separation, canonical bytes and resource limits.

For snapshots, preserve exact manifest bytes, source-key authority, transfer and
destination binding, fencing and live cutover checks. Evaluate standard-library
support, independent verification, wire size, validation complexity and custom
code removed. A recorded adopt/reject decision is required for each use case;
implementation is conditional on the corresponding decision. Do not add a second
signature wrapper merely to claim RFC adoption, or use optional location hints
to bypass authenticated endpoint discovery and SSRF defenses.

### Provider-chosen authentication and enterprise SSO

Providers own account authentication and may integrate Hail into their existing
email applications and login sessions. An email provider can expose email and
Hail messages after one existing account login. Federation does not require a
shared user-login mechanism. Provider-specific web/native clients implement or
delegate to that provider's chosen authentication and API contract.

Enterprise SSO is an essential supported architectural use case. Providers may
use [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html), SAML,
or their own directory-backed login. Microsoft Entra ID offers
[OIDC authentication](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc);
on-premises Active Directory or LDAP can be integrated behind an identity broker
or provider authentication backend. For example,
[Keycloak user federation](https://www.keycloak.org/docs/latest/server_admin/index.html#_user-storage-federation)
connects LDAP/AD directories to a standard identity service. LDAP directory access
and browser SSO are different layers; Hail clients need not implement LDAP or
collect directory passwords. No particular broker or directory connector is
mandated for every provider.

Provider administrators select trusted identity services and tenant boundaries.
OIDC account binding uses a validated issuer and subject, not email equality.
Specify enrollment, linking, organization membership, session/token revocation,
reauthentication and offboarding for the chosen integration. Enterprise login
and directory roles do not replace Hail owner/recovery signatures or automatically
grant custody/transfer authority.

Haili's current reference provider/client may retain passkeys. This is a local
implementation choice, not a requirement on other providers or their clients.
[WebAuthn](https://www.w3.org/TR/webauthn-3/) credentials remain RP/origin scoped;
provider transfer does not copy them between origins. The existing
[CLI client profile](../spec/client-api.md) already delegates browser login to the
provider and is authentication-method-neutral; the current reference GUI's
passkey APIs do not define the federation contract.

A shared OAuth client-access profile is optional interoperability work. Providers
that offer it can support independent clients without those clients implementing
the provider's login method. Use authorization code+PKCE with
[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html),
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) and
[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html). Web-client architecture
follows [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html); server-held
credentials are the baseline for a future reference-web-client OAuth adaptation.
Specify registration, redirects, scopes/audiences, refresh/revocation and logout,
plus metadata under [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html) and
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html). This does not require
replacing a provider's existing login, accepting arbitrary client identity
assertions, or making OAuth support a prerequisite for Hail federation.

### JMAP interoperability and notifications

Adopt [JMAP core](https://www.rfc-editor.org/rfc/rfc8620.html) at the client/provider
boundary with a specified RACR extension. Model messages, local read/trash state,
drafts, relationships, Grants and submission results while separating immutable
signed records from mutable local state. JSON API representations must preserve
exact signed CBOR/COSE bytes. Reuse existing provider services and storage.

Start with Session discovery and read-only message synchronization. Define account
isolation, stable IDs, durable changes/tombstones, cache invalidation and provider
transfer behavior. Add mutations with concurrency handling and explicit durable
submission retry semantics. JMAP batches are not implicit transactions and creation
IDs alone do not make separate requests idempotent. Advertise only implemented
capabilities. Exact RACR type and capability identifiers remain design work.

Standard JMAP mail clients do not automatically understand a RACR extension;
this plan does not claim generic email-client compatibility. The federation
protocol remains RACR.

JMAP state-change notifications and Web Push work together;
[RFC 9749](https://www.rfc-editor.org/rfc/rfc9749.html) integrates VAPID. Use event
streams while connected and encrypted Web Push for background wakeups followed
by authenticated synchronization. Notifications are hints, not message records,
delivery acknowledgements or read receipts. Minimize payloads, validate push
destinations, bound retries and retire subscriptions when authorization is lost.

### Long-term MLS encryption

Use [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) and its
[architecture](https://www.rfc-editor.org/rfc/rfc9750.html) as the basis for the
long-term encrypted-conversation profile. Clients retain device keys and plaintext;
providers enforce RACR admission and transport ciphertext. Define how MLS epochs
and device membership bind to RACR identities and conversation membership, including
removal, offline devices and provider migration. Define history access and recovery
separately from login recovery. Revisit plaintext validation/search, content
identity and deduplication. A provider-served web client also needs an explicit
threat model for malicious replacement of its JavaScript.

### Supporting standards and review rules

Apply ACE/CWT lessons to the authorization work: exact subject, audience, resource,
operation, expiry and revocation; explicit bearer versus proof-of-possession roles.
Use [AIF](https://www.rfc-editor.org/rfc/rfc9237.html) and
[CWT proof-of-possession](https://www.rfc-editor.org/rfc/rfc8747.html) as review
references. Preserve immediate local Grant revocation and check authority when
resources are used. Add only demonstrated missing constraints or tests; adopting
a generic token encoding is not itself an implementation objective.

Prepare media-type registrations under
[RFC 6838](https://www.rfc-editor.org/rfc/rfc6838.html) and allocation policies under
[RFC 8126](https://www.rfc-editor.org/rfc/rfc8126.html) for actual extension points.
Reuse existing allocations and domain-controlled URIs where appropriate. Current
media-type names are provisional and can be signed domain-separation values;
coordinate any name changes with wire changes before independent implementations
freeze them. Registration is not certification. Final templates depend on the
RFC 9995 and JMAP profile decisions; inventory can begin immediately.

For providers offering the optional OAuth profile, use OAuth metadata alongside
`/.well-known/jmap`/Session discovery to remove endpoint
and capability hard-coding. Preserve provider selection, authenticated endpoint
validation and token audience restrictions. Existing WebFinger/PLC discovery
continues to establish federation identity.

The HTTP and transport work has focused outcomes:

- Parse [structured fields](https://www.rfc-editor.org/rfc/rfc9651.html) according
  to each adopted grammar. Replace the retriever's single exact-string
  `Content-Digest` assumption with bounded handling of legal dictionaries under
  [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html); keep the signed body
  digest authoritative and define malformed/unsupported-algorithm behavior.
- Verify [HTTP caching](https://www.rfc-editor.org/rfc/rfc9111.html) cannot expose
  private content or protected negative responses across accounts. Distinguish
  internal authenticated content reuse from shared HTTP caching.
- Verify the existing [Content-Disposition](https://www.rfc-editor.org/rfc/rfc6266.html)
  and [filename*](https://www.rfc-editor.org/rfc/rfc8187.html) handling for Unicode,
  reserved/control characters and safe downloads; fix only demonstrated gaps.
- Verify [TLS service identity](https://www.rfc-editor.org/rfc/rfc9525.html) in the
  actual DNS/SSRF-aware transport, including delegated endpoints. Use maintained
  libraries and [TLS deployment guidance](https://www.rfc-editor.org/rfc/rfc9325.html).
  A trusted certificate chain must also match the selected service hostname.

Apply [RFC 9413](https://www.rfc-editor.org/rfc/rfc9413.html) and
[RFC 6709](https://www.rfc-editor.org/rfc/rfc6709.html) through explicit capabilities,
strict signed schemas, correctly extensible discovery/API objects and rejection
of security downgrades. Apply [RFC 3552](https://www.rfc-editor.org/rfc/rfc3552.html)
and [RFC 6973](https://www.rfc-editor.org/rfc/rfc6973.html) through concrete threat
and disclosure cases for providers, identity services, push services, network
observers, stolen credentials and malicious peers. Internationalized local parts
remain future roadmap work with explicit comparison/normalization rules; do not
silently normalize signed text.

## Standards implementation checklist

Status: phase 0 baseline recorded; phase 1 implemented and verified locally.
See [phase 1 evidence and limits](standards-phase-1.md); no deployment is implied.
Phase 2 implements full RFC 9995 envelope and snapshot signature replacement.
[Implementation, validation and cutover requirements](standards-phase-2.md) are
recorded. Only current envelope/snapshot signatures are supported; the confirmed
deployment has no message or connection history requiring compatibility.
Deployment remains separate.
Work in the numbered order by default. Independent HTTP checks and registration
inventory may run alongside profile design; notification work follows usable
JMAP synchronization, and MLS follows stable identity/authorization/data contracts.
Each item is complete only when its acceptance evidence is linked here. A design
decision is not an implemented feature. RFC 9995 implementation is conditional;
record a justified rejection as a completed evaluation, not a shipped feature.

### 0. Decisions and baseline

- [x] Record token-plus-signature retrieval, client authentication goals, JMAP and
  MLS directions, and reopen RFC 9995 evaluation for both envelopes and snapshots.
  Evidence: the standards adoption direction above.
- [x] Inventory existing behavior, reusable services, protocol objects and tests
  affected by each phase; identify exact spec/schema/vector owners before edits.
  Evidence: [implementation inventory and initial registration inventory](standards-baseline.md#phase-by-phase-implementation-inventory).
- [x] Define each phase's cutover and preservation requirements for authenticated
  history, existing accounts and custody, under the pre-launch policy.
  Evidence: [shared preservation rules](standards-baseline.md#shared-ownership-and-preservation-rules)
  and [phase cutover matrix](standards-baseline.md#cutover-requirements-by-phase).
  [Baseline validation](standards-baseline.md#baseline-validation-and-limits)
  records local evidence and its limits; later profile decisions remain open.

### 1. HTTP and transport foundations

- [x] Implement bounded Content-Digest dictionary handling for bodies/attachments;
  prove valid multiple digests work, invalid/mismatched digests fail as specified,
  and gzip-content versus uncompressed signed-body verification stays distinct.
  Evidence: [digest dictionaries](standards-phase-1.md#digest-dictionaries).
- [x] Verify private and protected-error responses cannot cross account boundaries
  through caches; fix any evidenced gap and retain discovery freshness rules.
  Evidence: [private caching](standards-phase-1.md#private-caching-and-downloads).
- [x] Verify Unicode/reserved filenames and control/path-character handling in
  attachment downloads; fix only evidenced gaps.
  Evidence: [download encoding and validation](standards-phase-1.md#private-caching-and-downloads).
- [x] Verify hostname/certificate checks, delegation and SSRF restrictions through
  real transport tests, including rejection of a trusted but wrong-host certificate.
  Evidence: [real TLS and attachment transport](standards-phase-1.md#real-tls-and-attachment-transport).

### 2. RFC 9995 profile decisions

- [x] Build minimal ordinary-envelope and snapshot candidates; document exact
  signed bytes, authenticated admission fields and domain separation. Verify each
  using an independent implementation or standard-library path.
  Evidence: [candidate layouts and independent verification](standards-phase-2.md#exact-candidate-layouts).
- [x] Compare generic tooling interoperability, custom code, wire size, limits and
  validation burden; record separate adopt/reject decisions with reasons.
  Evidence: [adopt descriptor-hash envelopes and manifest-hash snapshots](standards-phase-2.md#decision),
  with [measured tradeoffs](standards-phase-2.md#measurements-and-tradeoffs).
- [x] If adopting ordinary envelopes, update codecs, submission/retrieval metadata,
  authority checks, history representation and transfer handling together; prove
  tampering with parties, consent, expiry or content fails before body retrieval.
  Evidence: [production profiles and preservation](standards-phase-2.md#final-implementation-and-preservation)
  and [validation](standards-phase-2.md#implementation-validation).
- [x] If adopting snapshot wrappers, update export/import and prove wrong source,
  destination, transfer, modified manifest or unmet cutover authority is rejected.
  Evidence: [snapshot implementation and integration proof](standards-phase-2.md#implementation-validation).
- [x] Publish current-profile schemas and positive/negative cross-language vectors;
  document cutover and retire superseded formats where no distinct purpose remains.
  The body-hash candidate is not adopted; its runtime implementation is N/A.
  Evidence: [current encoding](../spec/encoding.md#rfc-9995-hash-profile),
  [vectors](../spec/vectors/README.md), and [cutover/rollback](standards-phase-2.md#cutover-and-rollback).

### 3. Token plus HTTP-signature retrieval

Depends on phase 1 parsing work and phase 2's envelope decision, not on adopting
RFC 9995. Keep this separable from client OAuth tokens.

Standards addressed: [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html).
RACR defines the application profile: mandatory token plus signature, authorized
recipient key, covered components, replay policy and concealed failure behavior.
Those authorization/privacy choices are not supplied by the RFC alone.

Implemented by the [retrieval signature profile](../spec/retrieval-signatures.md):
Ed25519 over method, full target URI and Authorization; 60-second signatures,
30-second clock skew, fresh random 32-byte nonces and durable provider-wide replay
rejection. Token checks precede recipient-key resolution. Body and attachment
requests both require the proofs; no bearer-only downgrade is supported.

Existing guidance to carry into that profile (do not reopen established choices):

| Choice | Existing guidance | Profile coverage |
| --- | --- | --- |
| Key and algorithm | [Body proof of possession](../spec/bodies.md#recipient-proof-of-possession) names recipient `#hail-messaging`; [DID key profile](../spec/did-profile.md#v0-key-algorithm-and-encoding) requires Ed25519 | RFC 9421 key identifier/algorithm parameters and constrained key lookup |
| Request binding and authorization | [Retrieval design](#retrieval-tokens-and-http-signatures) requires method, target and Authorization coverage, token-first lookup and both proofs | Exact covered-component list and signature parameters; do not reuse COSE numeric algorithm labels as HTTP parameters |
| Privacy | [Body authorization](../spec/bodies.md#retrieval-authorization) conceals failures; the retrieval design moves disclosure until both proofs pass | Uniform signature-failure scheduling and resource bounds |
| Attachments | [Attachment retrieval](../spec/attachments.md) binds files to an authorized body, shares token/fence rules, prohibits redirects and restarts retries from byte zero | Sign the exact attachment target under the same proof requirement |
| Retries and routing | [Retry ownership](../spec/delivery-state.md#retry-ownership) sets deadlines/backoff; [endpoint refresh](../spec/http-binding.md#redirects-and-endpoint-refresh) permits only authenticated endpoint changes | Fresh signature/nonce behavior on retries and changed targets |
| Rotation and transfer | [Key rotation](../spec/did-profile.md#key-rotation) rejects removed keys for new operations; continuity uses fenced state transfer | How request replay state and in-flight retrievals behave across restart/transfer |

The implementation uses the existing bounded response schedule and delivery
backoff. Concealed `404` responses trigger routing refresh and fresh-signature
retries through the effective delivery deadline, because slow/unavailable key
verification is deliberately indistinguishable from invalid authorization.
Replay state survives restart, is not copied as account history, and is retained
at its serving origin. The profile specifies same-origin storage replacement.

- [x] Specify the RFC 9421 profile: covered method/target/Authorization, recipient
  key role, freshness, replay state, retries, attachments and migration behavior.
- [x] Implement cheap token rejection before recipient-key resolution and require
  both token and recipient proof; preserve concealed failures until both pass.
- [x] Prove leaked tokens fail without the recipient key, wrong recipients and
  substituted paths fail, and malformed/missing signatures cannot reveal validity.
- [x] Prove legitimate retries, restarts, attachments and key/provider changes work;
  bound expensive attempts and prohibit bearer-only downgrade in the new profile.

Evidence: [request vector](../spec/vectors/retrieval-signature.json),
[signature tests](../apps/server/test/retrieval-signature.test.ts),
[database/HTTP proof](../apps/server/test/retrieval-signature.integration.test.ts),
and the signed connection-federation, attachment and TLS transport suites.

### 4. Provider authentication, enterprise SSO and optional client access

Decided: providers choose authentication; enterprise SSO must be permitted by the
architecture. Provider-specific clients follow that provider's contract. A shared
OAuth client-access profile is optional and separate from federation.

Standards addressed by the optional OAuth client-access profile (apply modern
security guidance to the base framework):

| Contract area | Standard |
| --- | --- |
| Authorization code, client roles and refresh | [RFC 6749 — OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749.html), constrained by [RFC 9700 — OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html) |
| Code interception protection | [RFC 7636 — PKCE](https://www.rfc-editor.org/rfc/rfc7636.html) |
| API bearer-token usage, where selected | [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) |
| CLI system-browser and loopback flow | [RFC 8252 — OAuth for native apps](https://www.rfc-editor.org/rfc/rfc8252.html) |
| Web-client credential/session architecture | [RFC 10017 — OAuth for browser-based applications](https://www.rfc-editor.org/rfc/rfc10017.html) |
| Authorization-server discovery | [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html) |
| Protected-resource discovery | [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) |
| Token revocation | [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html); browser logout/session termination must be specified separately |

Enterprise identity standards are separate from that optional client API:
[OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html), SAML and
[WebAuthn](https://www.w3.org/TR/webauthn-3/) are not RFCs. LDAP/Active Directory
integration belongs behind the provider's login or its chosen identity broker.
Supporting enterprise SSO in the architecture is required; implementing every
identity protocol or an LDAP connector in the reference provider is not implied.
The reference server implements a trusted existing-session integration boundary;
a production SSO protocol connector is not yet supplied. See the
[provider authentication contract](../spec/provider-authentication.md).

Core authentication and enterprise contract:

- [x] Record provider-owned authentication, provider-specific client integration,
  enterprise SSO compatibility and optional shared OAuth access.
  Evidence: [provider authentication decision](#provider-chosen-authentication-and-enterprise-sso).
- [x] Specify provider-account authentication, client/API authorization and
  independent owner/recovery authority as separate boundaries. Preserve Haili's
  passkey behavior without requiring passkeys for other providers.
- [x] Define the enterprise integration contract: administrator-approved issuers
  and tenants, stable account binding, provisioning/linking, organization access,
  reauthentication, revocation/offboarding and recovery. Do not auto-link by email
  or treat directory administrator status as independent Hail owner authority.
- [x] Verify that a provider can integrate Hail with its existing application and
  login session, including an enterprise SSO-backed flow, without a separate Hail
  credential enrollment. Use a test integration to prove the boundary; choose a
  concrete reference-provider SSO connector separately before production support.
- [x] Prove untrusted/wrong-tenant identity assertions, cross-account linking,
  disabled organizational access, scope escalation and login-only attempts at
  owner actions fail safely. Document session/revocation latency and enforcement.

Evidence: [integration and lifecycle contract](../spec/provider-authentication.md),
[provider authentication service](../apps/server/src/accounts/provider-authentication.ts),
and [database/HTTP integration tests](../apps/server/test/provider-authentication.integration.test.ts).
The test adapter represents an already-verified SSO application session; production
OIDC/SAML connector validation and passkey-independent sensitive-action UI remain
separate work. Integrated sessions cannot mint independent bearer credentials.

Optional shared OAuth client-access work (not a gate for provider federation):

- [x] Defer the optional shared OAuth profile until a client interoperability
  requirement justifies it; it is not part of this phase 4 implementation.
- [ ] Before implementing the optional profile, define code+PKCE,
  registration, issuer/resource discovery, redirects, scopes, audiences, token
  lifetime/refresh/revocation and logout using the RFCs above.
- [ ] If implemented, reuse existing authorization/policy services and document
  the cutover from the custom client exchange; retain exact-action approvals.
- [ ] Adapt participating GUI/CLI clients and prove interoperability with both
  passkey and enterprise-SSO providers through provider-hosted authorization.
  Provider-specific clients may continue using their provider's own API.
- [ ] Prove issuer/audience validation, code replay/CSRF protection and revoked or
  expired access rejection. Publish only capabilities actually implemented.

### 5. JMAP synchronization and operations

Standards addressed: [RFC 8620 — JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html)
for Session discovery, capabilities, method calls, query/get/set and change-state
semantics. The RACR extension defines the Hail-specific data model and authority
rules. [RFC 8621 — JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html) is a
reference for email semantics, not a claim that Hail implements its Email/Mailbox
model or supports generic JMAP Mail clients. Events/Web Push remain phase 6.

Phase 4's account authentication boundary is available; production OIDC and the
optional shared OAuth client profile are not prerequisites for the first slice.
Reuse existing session/scope policy without expanding it through JMAP.

The [phase 5 preparation](standards-phase-5.md) separates established direction,
proposed engineering defaults and the accepted requirement to preserve
read/unread state and saved drafts when moving between providers. Trash
portability is planned too; omit it only if a concrete complication justifies that,
with explicit non-resurrection rules. Begin with the wire/data contract and
read-only Session/query/get; do not claim complete synchronization or switch the
reference clients until change tracking and recovery are proven.

- [ ] Specify RACR JMAP types/capabilities, immutable-versus-local fields, exact
  signed-byte carriage, account isolation, identifiers and provider-transfer reset
  or continuity rules. Reuse current domain services and mailbox storage.
- [x] Implement authenticated Session discovery and read-only received-message query/get
  with explicit limits and supported capabilities. See the [initial profile](../spec/jmap.md);
  complete Core support and other object types remain pending.
- [ ] Implement durable changes/tombstones and resynchronization; prove two clients
  converge after create/update/delete, missed events and expired change cursors.
  Received-message and draft logs now cover their writers and cleanup; other
  collections and complete client synchronization remain pending.
- [ ] Implement read/trash state, drafts and required relationship/Grant workflows;
  prove concurrent edits are detected and owner consent cannot be bypassed.
  Individual read/unread and received-message Trash/restore/deletion are implemented
  with state/preference guards; web callers use JMAP and superseded routes are removed.
  Draft get/query/changes/set cover authoring, retention and send consumption;
  web draft callers use JMAP and superseded draft routes are removed.
  Sent, whole-account cleanup and other mutations remain.
- [ ] Extend managed and portable account transfer to preserve read/unread state,
  saved drafts with their required content/references. Trash portability is
  planned; if a concrete complication requires omission, define omission semantics
  without resurrecting trashed/deleted items.
  Return imports now allow deleted received copies/cache entries to stay absent,
  while retaining signed history and shared bodies still needed by surviving copies.
  Portable v9/managed v10 preserve drafts, required uploads and preferences; Sent-state
  transfer remains pending. Update transfer schemas and
  versions together; prove cutover/retry/return behavior without lost state,
  resurrected mailbox copies or automatically sent drafts. Client synchronization
  state may reset, but preserved user data must not.
- [ ] Implement submission with durable idempotency; prove an ambiguous retry sends
  one logical message and acceptance remains distinct from recipient delivery.
- [ ] Move reference clients to the supported profile; document interoperability
  boundaries without claiming generic JMAP Mail client support. Remove superseded
  account API routes, cursors and compatibility-only tests with each replaced
  workflow; no legacy API compatibility period is required. See the
  [replacement policy](standards-phase-5.md#replacement-policy-remove-superseded-account-api-machinery).

### 6. JMAP events and Web Push

- [ ] Implement connected state-change events and encrypted Web Push subscriptions
  with VAPID; advertise only supported notification capabilities.
- [ ] Prove reconnect and duplicate/lost notifications converge through JMAP sync;
  enforce subscription authorization, destination validation, expiry and revocation.
- [ ] Verify payload minimization and bounded retries; prove push delivery neither
  changes read state nor substitutes for RACR delivery evidence.

### 7. Publication and interoperability completion

Inventory starts in phase 0; finalize names after wire/capability decisions, before
calling those profiles stable. Each earlier phase still updates its spec immediately.

- [ ] Complete media-type/extension inventory, registration templates and necessary
  allocation policies; align exact signed names across specifications and codecs.
- [ ] Complete applicable registration submissions and track their actual status;
  do not label provisional values registered or imply IETF adoption.
- [ ] Review security/privacy and ACE/CWT-derived authority cases for every new
  profile, including downgrade, migration and adversarial-provider scenarios.
- [ ] Record independent client/provider or codec interoperability evidence with
  its limits; update draft references and inventories consistently.

### 8. Long-term MLS conversations

- [ ] Specify the client threat model, device credentials, membership/epoch binding,
  encrypted-body format, history access and recovery, including web-code delivery.
- [ ] Implement one complete encrypted-conversation path with client-held keys and
  ciphertext retrieval, preserving recipient consent and required metadata checks.
- [ ] Prove multi-device/offline delivery, removals, state loss, key updates and
  provider migration; document plaintext search/validation and deduplication changes.
- [ ] Publish interoperability vectors and security-review evidence before claiming
  the encrypted profile complete.

### Completion evidence for each shipped phase

Repeat these gates in each phase's completion record; checking one phase does not
establish completion of the others.

- [ ] Behavior and acceptance cases pass at the affected boundaries; link commands,
  results and relevant positive/negative interoperability vectors.
- [ ] Specs, schemas, current-version inventory and applicable draft references
  match the implementation; unresolved decisions are explicit.
- [ ] Record revision/PR, cutover or migration notes and material limitations.
  Local checks, merged work and production deployment are distinct statuses;
  this checklist alone does not authorize a production release.
