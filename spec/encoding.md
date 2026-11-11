# Hail Data Encoding And Signature Profile

Status: Draft

This document defines the sole Hail-owned payload, body, and signed-object representation for v0. It is influenced by the constrained data-model approach used by DRISL and AT Protocol, but Hail does not claim representation or protocol interoperability with either system.

## Protocol Boundary

Deterministic Hail CBOR is used for RACR protocol payloads, bodies and checkpoint hash inputs. The explicitly scoped reference snapshot profile in [transfer-formats.md](transfer-formats.md) instead signs a digest of exact retained JSON manifest bytes. JSON is not an alternate encoding of these signed or hashed values. Explicit HTTP bindings may wrap their exact bytes in base64url JSON fields.

Externally defined formats retain their own encodings. In particular, WebFinger JRD and rendered DID documents remain JSON. RFC 9457 Problem Details and the fixed generic HTTP receipt also remain JSON. Client-to-provider APIs are outside the Hail federation boundary and may expose JSON or native application types.

## Hail Data Model

A Hail value is exactly one of:

- null
- boolean
- integer from `-(2^53 - 1)` through `2^53 - 1`, further restricted by its schema
- Unicode text string encoded as valid UTF-8
- byte string
- finite array of Hail values
- finite map from unique text-string keys to Hail values

Floating-point values, CBOR undefined, non-text map keys, and CBOR tags inside Hail payloads and bodies are prohibited. A schema may prohibit null, negative integers, empty values, or other values admitted by the general model. Null and an absent map member are distinct.

Application map keys remain descriptive text strings. Integer application labels are not part of v0. Every v0 protocol payload and nested application map is closed unless its object specification explicitly says otherwise; an unknown member is rejected.

## Deterministic Encoding

Hail uses CBOR as defined by RFC 8949 with its core deterministic encoding requirements and these additional rules:

- Integers and length arguments use their shortest permitted encoding.
- Maps use deterministic encoded-key ordering.
- Maps, arrays, text strings, and byte strings use definite lengths.
- Duplicate map keys are rejected before conversion into an implementation-native map.
- Text must be well-formed UTF-8. A byte string is never accepted where a schema requires text, or vice versa.
- No application payload or body contains a CBOR tag.
- Exactly one complete item is present and no trailing bytes are accepted.
- A receiver performs bounded decoding, deterministically re-encodes the value, and requires byte-for-byte equality with the received bytes before accepting it as a Hail payload or body.

Unicode normalization is a schema property rather than a CBOR property. Fields that require NFC continue to require NFC; other text is not silently normalized during encoding or verification.

The terms **deterministic payload bytes** and **deterministic body bytes** in Hail specifications mean the exact bytes produced by this section.

## Diagnostic JSON

Specifications and tools may display Hail values as diagnostic JSON. Diagnostic JSON is never signed, hashed, or treated as a canonical payload representation. A transport JSON wrapper is a separate, explicitly specified structure; it does not authorize substituting diagnostic JSON for its embedded CBOR/COSE bytes.

Text, integers within the Hail range, booleans, null, arrays, and text-keyed maps use their corresponding JSON forms. In a schema-known byte-string field, diagnostic JSON uses the field's specified unpadded base64url text rendering. Tools must use the schema and must not automatically interpret arbitrary strings as binary values.

Examples in object specifications are diagnostic JSON unless explicitly identified as CBOR diagnostic notation or hexadecimal wire bytes. Values named with placeholders such as `base64url-*` illustrate field purpose and are not valid length-conforming test vectors.

## COSE_Sign1 Profile

Every object in the signed-object inventory below is one tagged COSE_Sign1 structure under RFC 9052. Envelopes and snapshots use the RFC 9995 hash profile below. The following direct-payload profile applies to the other listed objects. Transfer handshake records retain their separately defined signatures in [transfer-formats.md](transfer-formats.md):

```cbor-diag
18([
  << { 1: -19, 3: "application/hail-grant+cbor", 4: h'...' } >>,
  {},
  h'...',
  h'...'
])
```

The example content type is object-specific. The four array elements are the protected-header byte string, empty unprotected-header map, embedded payload byte string, and signature byte string.

Rules:

- CBOR tag 18 is required. An untagged COSE_Sign1 is rejected.
- The COSE structure and protected-header map use RFC 8949 deterministic encoding.
- The embedded payload is the exact deterministic encoding of one closed Hail payload map.
- The protected map contains exactly labels `1` (`alg`), `3` (`content type`), and `4` (`kid`).
- `alg` is integer `-19`, the fully specified COSE `Ed25519` algorithm registered by RFC 9864. Deprecated polymorphic `EdDSA` value `-8`, other algorithms, negotiation, and fallback are rejected.
- `content type` is the exact object-specific parameterless Hail `+cbor` media-type text string named by that object's specification.
- `kid` is the byte string containing the UTF-8 encoding of the canonical absolute DID URL for the required key role. When the payload has a `key_id` field, it exactly matches that field after UTF-8 decoding; otherwise it is derived from the signed party DID and the object-specific role.
- The unprotected map is empty. Unknown protected or any unprotected parameters are rejected in v0.
- The payload is embedded; detached payloads and a null payload element are rejected.
- External AAD is the empty byte string.
- The signature is exactly 64 bytes and is created and verified using the RFC 9052 `Sig_structure` and the key identified by `kid`.
- The complete tagged COSE_Sign1 item has one deterministic encoding and contains no trailing bytes.

The object-specific protected content type, signed payload `type`, fixed algorithm, exact key role, and closed schema jointly provide domain separation. A verifier validates every one of those properties rather than only the cryptographic signature.

The term **complete signed representation bytes** means the exact complete tagged deterministic COSE_Sign1 bytes.

## RFC 9995 hash profile

Ordinary envelopes use [RFC 9995](https://www.rfc-editor.org/rfc/rfc9995.html)
with exactly these protected labels: `1: -19` (Ed25519), `4: kid`,
`258: -16` (SHA-256), `259: "application/hail-envelope+cbor"`.
The embedded COSE payload is the 32-byte SHA-256 of the exact deterministic
closed envelope descriptor. The unprotected map contains exactly
`"https://racrproto.com/ns/racr/preimage": descriptor_bytes`. This domain-controlled
text label is a RACR extension, not a registered numeric COSE label.

Tag 18, deterministic encoding, empty external AAD, 64-byte Ed25519 signature,
and the sender's exact `#hail-messaging` key role remain required. Labels 3 and
260, unknown headers, detached/null digests, and alternate preimage locations
are prohibited. Verify the preimage hash before exposing descriptor fields;
verify the signature and current authority before admission or body retrieval.
The descriptor is not another signed envelope. Its application schema versions
1–4 and all authorization rules remain unchanged.

```text
protected = deterministicCBOR({1: -19, 4: UTF8(kid), 258: -16,
                              259: "application/hail-envelope+cbor"})
digest = SHA256(descriptor_bytes)
input = deterministicCBOR(["Signature1", protected, h'', digest])
wire = deterministicCBOR(18([protected,
       {"https://racrproto.com/ns/racr/preimage": descriptor_bytes}, digest,
       Ed25519(input)]))
```

Limits: descriptor 16384 bytes, complete envelope 17408 bytes, protected header
1024 bytes. The descriptor hash remains `envelope_digest`; it is not the hash of
the complete signed representation. Other objects keep their documented digest
domains. Current admission MUST reject the superseded direct-payload envelope.
Reading saved envelopes uses this same current hash profile; old namespace labels
and superseded direct-payload envelopes are unsupported. See [account history](account-history.md).

Snapshots use the same signature structure but an empty unprotected map and the
exact manifest carried separately. Their purpose/version-specific label 259 and
limits are defined in [transfer formats](transfer-formats.md#snapshot-profile-and-standardization-boundary).
The inventory's envelope content type denotes label 259; other rows use label 3.

### Protocol namespace cutover

Current writers MUST use `https://racrproto.com/ns/racr/preimage`. This is a fixed
protocol identifier, never a provider-specific endpoint and never dereferenced.
The reference provider's `haili.app` origin does not own the protocol namespace.

Readers and writers MUST use the current label exclusively. The former
`https://haili.app/ns/racr/preimage` label, a map containing both labels, and
arbitrary provider-domain labels MUST be rejected. There is no fallback.

This is a pre-launch namespace correction. The operator confirmed there are no
subscriptions, connections or messages requiring old-envelope compatibility.
Account identities, keys, recovery material and snapshot signature purposes do
not depend on this unprotected header name. No account-data migration or deletion
is needed. Synthetic history fixtures are recaptured from isolated workflows to
exercise the current format, not rewritten and presented as original evidence.

JMAP capabilities likewise use `https://racrproto.com/ns/jmap/` with the existing
`messages`, `drafts`, `account`, `events` and `push` suffixes. Clients and providers
use only these current capability names; no provider-domain JMAP alias is advertised.
Object IDs, serving generations, synchronization states, tokens, keys and user data
are not changed by this namespace correction. Frozen experimental RFC 9995 candidates
retain their original labels solely as evaluation artifacts, not current identifiers.

**Rollout and rollback:** coordinate the alpha provider and web/CLI/shared-client
upgrade. Old clients cannot use renamed JMAP capabilities, and old providers
cannot accept new envelope carriers. Reload browsers and upgrade the CLI;
credential reenrollment is not required solely by this change. No mixed-version
fallback is defined. Before any new-format messages exist, coordinated binary
rollback is possible; after new writes, an older binary cannot read those envelopes
and is not a safe rollback without a separately reviewed data plan. Do not rewrite
signed history or automatically delete user data to enable rollback.

## Signed Object Types

| Payload type | Protected content type | Required key role |
| --- | --- | --- |
| `hail.address-binding` | `application/hail-address-binding+cbor` | `#hail-identity` |
| `hail.sender-profile` | `application/hail-sender-profile+cbor` | `#hail-messaging` |
| `hail.grant` | `application/hail-grant+cbor` | `#hail-identity` |
| `hail.envelope` | `application/hail-envelope+cbor` | `#hail-messaging` |
| `hail.delivery-status` | `application/hail-delivery-status+cbor` | `#hail-messaging` |
| `hail.connection-invitation` | `application/hail-connection-invitation+cbor` | `#hail-identity` |
| `hail.connection-confirmation` | `application/hail-connection-confirmation+cbor` | `#hail-identity` |
| `hail.connection-control` | `application/hail-connection-control+cbor` | `#hail-messaging` |
| `hail.conversation` | `application/hail-conversation+cbor` | creator's `#hail-messaging` |

The historical `hail.connection-grant` shape in the codec/CDDL is not the current
coordinator-based connection admission mechanism. Its support is not required.
Connection HTTP exchanges embed COSE bytes in JSON as defined in
[connection-wire.md](connection-wire.md). Transfer wrappers and signature domains
are defined separately in [transfer-formats.md](transfer-formats.md).


When sent directly as an HTTP entity, a COSE object uses:

```text
application/cose; cose-type="cose-sign1"
```

Media types are parsed and compared under HTTP media-type rules, not as raw strings. For the outer signed-object type, the type and subtype must be `application/cose`, the `cose-type` parameter must have value `cose-sign1`, and no other parameter is permitted; insignificant whitespace, case-insensitive type or parameter names, and equivalent quoted or token parameter values do not cause rejection.

The protected content type identifies the embedded object. The Hail `+cbor` values are provisional until registration or final allocation, but they are fixed domain-separation values within this draft and must not be changed by implementations. Finalizing their registration is required before stable v0 publication. v0 applies no HTTP content coding to a signed COSE representation.

## Binary Values At Text Boundaries

SHA-256 values are exactly 32-byte byte strings inside Hail payloads. Where a URL path segment, strong ETag opaque value, or diagnostic JSON field requires text, the bytes use unpadded base64url under RFC 4648 and produce exactly 43 ASCII characters. Padding, percent encoding, and noncanonical base64url are rejected where the relevant HTTP binding requires the literal form.

Bearer-token entropy is exactly 32 bytes in an envelope payload. The `Authorization` header renders those bytes as unpadded base64url after the `Bearer` scheme. The decoded header value must be exactly 32 bytes.

RFC 9530 `Content-Digest` uses that standard's structured-field byte-sequence syntax and standard base64. It covers the HTTP message content, including gzip content coding when present, and is not the signed digest of the uncompressed deterministic Hail Body. It is not the base64url representation used by Hail URL paths and ETags.

## Digest Domains

Hail uses SHA-256 but intentionally has more than one input domain:

- Address Binding and Sender Profile representation digests hash complete signed representation bytes.
- A Grant revision digest hashes complete signed representation bytes and supplies both the next revision's `previous` byte string and the current strong ETag's base64url opaque value.
- An Envelope payload digest hashes deterministic payload bytes, excluding the COSE wrapper. Replay handling and Delivery Status use this same digest.
- A Body content digest hashes exact uncompressed deterministic body bytes.
- A conversation descriptor hash covers the complete COSE representation.
- A connection proof hash covers the exact deterministic CBOR proof bundle; an acknowledgement hashes the complete received control COSE bytes.
- Transfer handshake digests cover deterministic payload bytes, excluding detached signatures. Snapshot and checkpoint domains are defined in [transfer-formats.md](transfer-formats.md).

Specifications must name the domain and must not use an unqualified phrase such as “canonical object hash.”

## Resource Safety

An implementation applies transport-byte limits before decoding and uses a decoder with explicit nesting, collection, string, and total-allocation limits. It rejects oversized declarations before allocation where possible. Object specifications define transport and semantic limits; accepting valid small inputs does not require allocating according to attacker-controlled lengths.

### Current CBOR Budgets

The following inclusive limits apply to a decoded Hail body or signed-object
payload. Implementations MUST reject values exceeding them and MUST support
otherwise valid values within them, subject to the object's stricter schema and
representation-size rules. A larger provider-local decoder budget does not extend
the interoperable profile.

| Budget | Maximum |
| --- | ---: |
| Encoded bytes | 1048576, further bounded by the object's representation limit |
| Item depth | 32 |
| Total items | 16384 |
| Elements in one array | 4096 |
| Entries in one map | 256 |
| UTF-8 bytes in one text string, including a map key | 1048576 |
| Bytes in one byte string | 1048576 |

Counting is defined on the CBOR data, independently of host-language objects:

- The root item has depth zero and counts as one item. Every array or map counts
  as one item, including an empty container. Each array element, map key and map
  value is an item at its containing collection's depth plus one. Nested items
  count recursively. A map with two scalar keys and two scalar values has five
  items including the map itself.
- Text and byte strings each count as one item; their contents do not count as
  nested items. Text lengths are UTF-8 octets, not characters or UTF-16 units.
  Map entries count key/value pairs, not individual keys and values.
- Encoded size includes CBOR headers. For example, a 1048571-byte byte string
  occupies 1048576 encoded bytes; a 1048576-byte string exceeds that encoded budget.
- Budgets restart for each independently decoded CBOR domain. COSE's payload and
  protected-header byte strings count as single items in the outer representation;
  their embedded CBOR is checked separately, not charged twice to the outer budget.

For the COSE wrapper, the maximum depth is 8, total items 256, array length 8,
map entries 8, and text-string length 1024. Its encoded-byte and byte-string
ceilings equal the object's complete signed-representation limit. Tag 18 counts
as one item at depth zero and its enclosed array is at depth one; no other tags
are permitted. The protected-header domain uses those same wrapper budgets but
with a 1024-byte encoded/byte-string ceiling, depth zero at its map, and no tag.
The exact COSE shape, labels and signature rules remain mandatory even when an
otherwise different structure fits these budgets.

These budgets do not apply wholesale to transfer snapshots or history checkpoint
domains, whose larger bounds are specified in [account history](account-history.md)
and [transfer formats](transfer-formats.md). They do not authorize whole-snapshot
allocation from an untrusted declared size. Decoder working memory and concurrent
work MUST remain bounded in addition to the wire budgets.

[Resource vectors](vectors/cbor-resource-limits.json) define exact boundary bytes
using repeated hex segments, expected lengths/digests and accept/reject results.
Small test-only budget overrides isolate counting rules; they are not additional
negotiated wire profiles.

The common signed-object validation sequence is:

1. Enforce HTTP method, media type, content coding, framing, and representation-size requirements.
2. Perform bounded structural CBOR and COSE decoding.
3. Require tag 18, the exact four-element COSE_Sign1 shape, deterministic protected headers, the profile-specific closed unprotected map, bounded embedded payload, and a 64-byte signature.
4. For hash envelopes, validate the digest/preimage binding first. Require the application descriptor's (or direct payload's) exact deterministic encoding and validate its closed schema and inexpensive field relationships.
5. Apply any object-specific privacy-safe preliminary lookup.
6. Resolve and validate the protected `kid`, its controller, algorithm, and required Hail key role.
7. Verify the COSE signature and require the authenticated signer to equal the applicable signed party.
8. Only then mutate authenticated protocol state or disclose protected detail.

Object specifications may add checks but do not weaken this sequence.

## Versioning

Hail defines one deterministic CBOR encoding and the COSE profile above, plus the explicitly specified transfer signature profiles. Current object versions are listed in [README.md](README.md); alpha interoperability does not require historical formats. The earlier JSON/JCS/JWS draft was not deployed and is not an alternate v0 representation. Supporting another encoding or security algorithm requires an explicit future profile with negotiation, downgrade prevention, digest-domain, retained-evidence, and migration rules.

## Structural Schemas

The draft CDDL structures for protocol objects are maintained in [hail.cddl](hail.cddl). The current transfer manifest and logical history record shapes are defined by [JSON Schema](schemas/account-history-v11-v12.json) and [account-history.md](account-history.md). They define representation-level shapes and sizes. The object specifications remain authoritative for identifier grammar, Unicode normalization, ordering, conditional presence, cross-field relationships, authorization, and state transitions until those constraints are also available in executable validators.

## Implementation Deliverables

Before Hail claims cross-implementation interoperability, the project must publish:

- CDDL or equally precise machine-readable schemas
- a reference deterministic encoder and strict decoder
- complete payload and COSE hexadecimal vectors for every signed object type
- digest and HTTP-boundary conversion vectors
- negative vectors for every prohibited CBOR and COSE form
- cross-language conformance results
- realistic size, allocation, encode/decode, sign/verify, and end-to-end benchmarks

## Publication identifiers and registration templates

This is the current publication inventory; the [profile index](README.md#current-profiles)
owns versions, and the object specifications own schemas and authority rules.
The earlier [phase 0 inventory](../agents/standards-baseline.md#initial-media-type-and-extension-inventory)
is superseded by this section. The namespace correction below moves current protocol identifiers to `racrproto.com`.

### Media-type inventory

The nine exact protected content types in [Signed Object Types](#signed-object-types)
plus the following four types are the current registration candidates. The
historical `application/hail-connection-grant+cbor` is excluded: retaining a codec
shape does not make it a current creation profile or a registration candidate.

| Media type | Representation and specification | Parameters |
| --- | --- | --- |
| `application/hail-body+cbor` | Deterministic CBOR content document; [bodies](bodies.md), [SPT bodies](bodies.md), [assets](assets.md), [attachments](attachments.md) | None |
| `application/hail-transfer+json` | UTF-8 JSON lifecycle request/response wrappers, with separately authenticated embedded objects; [transfer formats](transfer-formats.md#http-operation-inventory) | None |
| `application/hail-portable-snapshot+json` | Exact retained portable JSON manifest preimage, not its COSE wrapper; [transfer formats](transfer-formats.md#snapshot-profile-and-standardization-boundary), [history](account-history.md) | Required `version=11` |
| `application/hail-managed-snapshot+json` | Exact retained managed JSON manifest preimage, not its COSE wrapper; same owners | Required `version=12` |

The nine `+cbor` protected types describe deterministic **payload/preimage** maps,
not tagged COSE containers. HTTP delivery of their signatures uses the existing
`application/cose` allocation. Snapshot `version` parameters are part of the
exact signed label 259 string; HTTP normalization does not apply to signed names.

### Registration template fields

These are preparation templates under [RFC 6838 section 5.6](https://www.rfc-editor.org/rfc/rfc6838.html#section-5.6).
Each candidate above or in the signed-object table instantiates the common fields
below with its exact subtype and the per-format specification/security entry.
This shared form avoids thirteen independently drifting copies. When submitting,
expand one complete template per type and replace repository references with
immutable published references. The status below applies to every candidate.

| Field | Value |
| --- | --- |
| Type name | `application` |
| Subtype name | Exact portion after `application/` in the candidate's media type, without parameters |
| Required parameters | None, except the two snapshot types' `version` as listed above |
| Optional parameters | None |
| Encoding considerations | Binary for `+cbor`; 8bit UTF-8 for `+json` |
| Security considerations | The format-specific entry below, this document's bounded decoding and signature rules, and [profile security review](README.md#standards-profile-security-review) |
| Interoperability considerations | Closed alpha schemas; no unknown-field or signature fallback. Exact bytes and current authority must be verified. See [current profiles](README.md#current-profiles) and [conformance evidence](vectors/README.md#phase-7-evidence-and-limits). Generic CBOR/JSON parsing does not establish RACR validity. |
| Published specification | This specification and the format-specific entry below; immutable reference to be fixed at submission |
| Applications that use this media type | RACR messaging providers, Hail clients, and independent codec/history consumers |
| Fragment identifier considerations | None defined; no fragment-based selection of signed or authorized subobjects |
| Deprecated alias names | None |
| Magic numbers | None |
| File extensions | None assigned |
| Macintosh file type codes | None assigned |
| Person and email address to contact | Jason Creviston, j4@j4crev.com (existing draft author; confirm for external submission) |
| Intended usage | LIMITED USE (experimental RACR interoperability) |
| Restrictions on usage | Use only with the applicable RACR profile; a media type alone grants no delivery, retrieval or migration authority |
| Author | Jason Creviston and Hail contributors |
| Change controller | Proposed author control pending publication-stream review; no IETF change control or endorsement is asserted |
| Provisional registration? | Not submitted; see registration status below |

| Subtype | Format-specific specification and security considerations |
| --- | --- |
| `hail-address-binding+cbor` | [Address binding](address-binding.md): domain publication AND current identity signature; retained bindings do not preserve current domain authority |
| `hail-sender-profile+cbor` | [Sender profile](sender-profile.md): messaging signature, bounded assets and monotonic revision; display metadata does not establish organizational identity or consent |
| `hail-grant+cbor` | [Grants](grants.md): recipient identity signature, exact consent context, category limits, revision/revocation ordering |
| `hail-envelope+cbor` | [Envelopes](envelopes.md): RFC 9995 descriptor hash, current sender authority, recipient consent, replay and deadlines; token-bearing descriptors require private storage |
| `hail-delivery-status+cbor` | [Delivery state](delivery-state.md): recipient signature and original-envelope correlation; provider delivery is not a read receipt |
| `hail-connection-invitation+cbor` | [Connection consent](connection-auth.md), [wire](connection-wire.md): inviter identity signature and explicit review, not unsolicited delivery authority |
| `hail-connection-confirmation+cbor` | Same owners: invitee identity signature and exact reviewed invitation/coordinator binding |
| `hail-connection-control+cbor` | [Connection federation](connection-federation.md), [wire](connection-wire.md): authenticated participant controls, disconnect and replay semantics |
| `hail-conversation+cbor` | [Shared conversations](shared-conversations.md): creator signature, roster binding, membership/leave and per-recipient authorization |
| `hail-body+cbor` | [Bodies](bodies.md), [SPT bodies](bodies.md), [assets](assets.md), [attachments](attachments.md): inert rendering, bounded decompression/decoding, digest-bound local assets; never arbitrary active HTML |
| `hail-transfer+json` | [Transfer formats](transfer-formats.md): closed lifecycle wrappers, exact embedded proofs, source/destination/transfer binding; wrapper parsing is not authorization |
| `hail-portable-snapshot+json` | [History](account-history.md), [transfer formats](transfer-formats.md): private exact manifest bytes, user authority, fences and live cutover evidence |
| `hail-managed-snapshot+json` | Same owners plus [managed custody](managed-custody.md): administrator/monitor authority is distinct from portable owner authority |

### Extension allocation policy

No new IANA registry, numeric COSE label, algorithm, URI scheme, well-known suffix,
or structured syntax suffix is requested. Reuse existing CBOR/COSE, `+cbor`/`+json`,
HTTP signature and JMAP allocations. The [RFC 8126](https://www.rfc-editor.org/rfc/rfc8126.html)
review yields the following scoped decisions, not a global RACR registry:

| Surface | Allocation and change rule | Definition owner |
| --- | --- | --- |
| COSE preimage text label `https://racrproto.com/ns/racr/preimage` | Domain-controlled URI; exact closed-profile key, no private numeric allocation or alternate spelling | [Hash profile](#rfc-9995-hash-profile) |
| WebFinger relation `https://racrproto.com/rel/address-binding` | Extension relation URI; no registered short relation token requested | [Address binding](address-binding.md) |
| DID fragments `#hail-identity`, `#hail-messaging`, `#hail`; service `HailMessaging` | Exact application profile names; preserve unrelated DID entries; no new DID method | [DID profile](did-profile.md) |
| `_hail-provider` DNS delegation convention | Existing TXT-record application convention, not a new DNS RR type; delegation only under its authenticated discovery rules | [Address binding](address-binding.md) |
| JMAP `https://racrproto.com/ns/jmap/` capabilities: `messages`, `drafts`, `account`, `events`, `push` | Domain-controlled capabilities; require the advertised capability and method-specific authority. No `urn:ietf:params:jmap:*` RACR allocation | [JMAP](jmap.md), [drafts](jmap-drafts.md), [collections](jmap-collections.md), [events](jmap-events.md) |
| `hail-retrieval-v1` signature tag and `hail` signature dictionary member | Fixed application-profile identifiers; no negotiation or bearer-only fallback | [Retrieval signatures](retrieval-signatures.md) |
| `hail.*` types, object versions, SPT profiles, authorization selectors and status/reason values | Closed specification-owned sets, not first-come allocations. Changes require updated normative schema, authority rules and positive/negative vectors; unknown-value behavior stays object-specific | [Profile index](README.md#current-profiles), [CDDL](hail.cddl), [delivery state](delivery-state.md) |
| Transfer, checkpoint, consent, activation and monitor signature domains | Purpose-specific exact byte strings; retain only current distinct purposes and required authenticated evidence. Never normalize or alias a domain | [Transfer formats](transfer-formats.md), [history](account-history.md), [monitor providers](monitor-providers.md), [monitor incidents](monitor-incidents.md) |
| Account `racr.*` types, scopes and login identifiers | Reference client/provider contract; changes do not allocate federation authority | [Client API](client-api.md), [provider authentication](provider-authentication.md) |
| Optional OAuth and MLS identifiers | Deferred; no allocation or capability claim for unimplemented profiles | [Design roadmap](../agents/DESIGN.md) |

For a future open extension point, its proposal must specify the namespace owner,
allocation/review procedure, required registration fields, collision handling,
unknown-value behavior, negotiation and downgrade constraints before use. A new
name alone never extends a closed schema or grants authority. Domain-controlled
identifiers remain stable even when the account's hosting provider changes.

### Registration status and remaining publication gates

As of 2026-11-11, the thirteen templates are prepared locally, not submitted or
registered. The [IANA media-type registry](https://www.iana.org/assignments/media-types/)
lookup found no `hail-` entries. Here, “provisional” describes project-local names;
it does **not** mean an entry in IANA's provisional registry.

The chosen names are in the standards tree. Under RFC 6838 section 3.1 and the
IANA registry's procedure, their final registration requires the applicable
standards publication/approval path. The project does not claim recognition as a
standards organization. An unsubmitted individual Experimental draft does not
establish that path or qualify the project automatically for provisional registration.
Keep these exact names for current alpha interoperability; do not introduce a
vendor-tree rename just to mark registration work complete.

External submission remains pending publication-path and author/contact confirmation,
and a stable public specification reference. [Draft submission preparation](../drafts/README.md#before-submission)
owns that handoff. Record the submission date, actual request/Datatracker URL,
assigned values and disposition here when they exist. If review requires renamed
signed values, coordinate codecs, schemas, vectors, retained evidence and writer/reader
cutover before adoption. Local preparation does not imply registration, IETF
adoption, stability, deployment, or resolution of historical recovery authority.
