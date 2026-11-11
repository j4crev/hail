# Phase 2: replace the signed envelope with an RFC 9995 profile

Status: production implementation and local verification complete, 2026-11-10.
The chosen profile replaces live envelope and snapshot signatures. Deployment is
separate; no provider has been released by this work. Experimental candidates
remain test-only and differ from the final preimage carriage below.

## Decision

**Ordinary envelopes: adopt the descriptor-hash design as the target replacement.**
Use one RFC 9995 COSE_Sign1, with a SHA-256 digest of the complete deterministic
RACR descriptor as its payload, and the exact descriptor bytes carried alongside
in a defined unprotected header. Retire the old envelope signing representation
at the explicit cutover. Do not wrap an old signed envelope or require two signatures.
The body-hash/protected-metadata alternative is viable but is not selected.

This completely replaces the signed envelope representation. It cannot replace
RACR's application semantics: recipient, sender, consent, category, expiration,
conversation membership, reply authority, body availability and access credentials
still need authenticated definitions. The current `hail.envelope` payload schema
can become the descriptor schema without a second signed container. Merely calling
it a standard COSE header would not standardize those semantics.

**Snapshots: adopt an RFC 9995 manifest-hash container as the target replacement.**
Keep hashing exact retained JSON manifest bytes; replace the bespoke domain-prefix
signature with the same standard signature structure used by the descriptor design.
This decision does not change handshake signatures, source-key authority, history
schema, consent, fencing or live cutover checks. Snapshot writers/importers and the Rust CLI now use the final profile.

## What is standard and what remains our profile

[RFC 9995](https://www.rfc-editor.org/rfc/rfc9995.html) defines hash-envelope header
258 (hash algorithm), optional 259 (preimage content type) and 260 (location); it
prohibits content-type header 3. It supports COSE signature verification without
having the preimage. Our candidates use embedded SHA-256 digests and omit location
hints entirely. The signature uses the normal COSE `Sig_structure`.

RACR still defines the descriptor schema, required key role, algorithms, closed
header sets, limits, preimage carriage, canonical bytes and authorization gates.
The experimental domain-controlled text labels below are not registered numeric
COSE allocations. They must not be advertised as a stable profile or accepted by
production while implementation and publication are pending.

## Exact candidate layouts

The executable candidate definitions are in
[test/rfc9995-candidates.ts](../packages/hail-codec-ts/test/rfc9995-candidates.ts);
[experimental CDDL](../spec/experiments/rfc9995.cddl) describes their closed shapes.
In every case:

```text
protectedBytes = deterministicCBOR(protectedMap)
signatureInput = deterministicCBOR(["Signature1", protectedBytes, h'', digest])
signature = Ed25519(signatureInput)
wire = deterministicCBOR(18([protectedBytes, unprotectedMap, digest, signature]))
```

`alg=-19`, `payload-hash-alg=-16`, empty external AAD, a 32-byte digest and 64-byte
signature are fixed. `kid` is the exact UTF-8 sender/manifest DID plus
`#hail-messaging`; it selects a role, not a trusted key supplied by the peer.
The caller supplies the authenticated key and expected profile. Wrong profile,
role, algorithm, duplicate/unknown fields, noncanonical encoding, missing preimage
and mismatched preimage are rejected. Label 260 is never followed.

**Candidate A — hash the body.** Protected headers contain 1, 4, 258 and 259
(`application/hail-body+cbor`), plus critical text header
`https://haili.app/ns/racr/experimental-admission`. Its value is deterministic CBOR
of the complete existing descriptor with only `body.digest` removed. Header 2
lists that custom header as critical. The payload is the original body digest;
the unprotected map is empty. Verification reconstructs `body.digest` from the
fixed hash algorithm/payload, then validates the full existing descriptor.
All admission fields are signed in the protected metadata. A generic consumer can
verify the eventual body against the payload, but must understand the critical
RACR metadata extension to process the message.

**Candidate B — hash the descriptor (selected).** Protected headers contain only
1, 4, 258 and 259 (`application/hail-envelope+cbor`). The payload is SHA-256 of the
complete existing deterministic descriptor. The unprotected map contains exactly
`https://haili.app/ns/racr/experimental-preimage: descriptorBytes`. Although that
map is not directly signed, its sole byte-string value is authenticated by the
signed digest. Verify the signature and preimage hash before parsing/using the
metadata. Then apply existing schema, signer, recipient, freshness and consent
checks before starting body retrieval. The body digest remains inside the now
hash-authenticated descriptor. Stripping or replacing the descriptor must fail
admission even though a generic signature verifier can still validate the hash.

No unauthenticated metadata drives key-resolution URLs: the expected profile is
selected by the endpoint, key lookup is constrained to the DID role, and the
existing authenticated PLC/discovery rules remain required. None of these
experiments implements arbitrary location discovery.

**Snapshot candidate.** Same layout as B, but the preimage is the exact saved JSON
manifest and 259 is the provisional exact string
`application/hail-portable-snapshot+json;version=7` or
`application/hail-managed-snapshot+json;version=8`. These distinct protected values
separate snapshot purposes and versions. Whitespace changes, wrong destination,
transfer or DID change the hash. Verification must still authenticate the source
key against the live transfer context and run the complete manifest/cutover gates;
a valid hash signature alone cannot establish any of that authority.

## Measurements and tradeoffs

The [generator](../packages/hail-codec-ts/scripts/evaluate-rfc9995.ts) reuses all six
existing envelope examples across versions 1–4, including Grant, connection,
threaded reply and shared conversation modes. It freezes exact carrier bytes and
signature inputs in [experimental vectors](../spec/vectors/experimental-rfc9995.json).
All candidates use one fixed public test key; snapshot source manifests remain
exact copies of the actual-export fixtures. This key does not claim live PLC
membership or source authority for those fixtures.

Complete binary carrier sizes in bytes:

| Existing example | Current | A: body hash | B: descriptor hash |
| --- | ---: | ---: | ---: |
| Grant v1 | 779 | 776 | 792 |
| Connection v2 | 778 | 775 | 791 |
| Threaded connection v3 | 881 | 878 | 894 |
| Threaded reply v3 | 875 | 872 | 888 |
| Conversation introduction v4 | 1540 | 1537 | 1553 |
| Conversation reply-all v4 | 1078 | 1075 | 1091 |

The current column is the implemented RFC 9995 carrier. With experimental names,
A is 3 bytes smaller and B is 13 bytes larger. B costs another 16 bytes per
example but keeps protected headers at 92 bytes; A's headers are
669–1431 bytes and exceed the current 1024-byte protected-header ceiling for the
largest example. This is a profile/validation tradeoff, not a compression claim.
The 13-byte difference between production and B comes from the extension name.

| Snapshot fixture | Current JSON snapshot carrier | Candidate binary COSE carrier |
| --- | ---: | ---: |
| Portable v7 | 50816 | 37995 |
| Managed v8 | 25278 | 18842 |

The snapshot comparison includes the current JSON object's manifest, digest,
signature, type/version and source public key. The candidate keeps the raw manifest
and uses DID-role `kid`, assuming independently authenticated key resolution.
Most of the reduction is removing base64/JSON carriage, **not** RFC 9995 signature
compression. If a client API continues to base64-wrap COSE, that expansion remains.
The generator records the input and output lengths for reproduction.

The selected envelope design preserves the existing descriptor parser and its
resource boundary. The prototype caps the descriptor at 16 KiB, the carrier at
17 KiB, and B's protected bytes at 1 KiB. A allows a 16 KiB protected region and
requires separate bounded decoding of its metadata. Snapshot preimages retain
64 MiB limits, with 1 KiB carrier overhead. All outer scans bound depth/items/maps
before general decoding. The final envelope profile uses these same limits.

**Interoperability benefit:** a standard hash-envelope reader can locate the hash,
identify its preimage format and verify the signature using the standard signature
structure. B avoids requiring generic tooling to understand a critical admission
extension. It must still use the RACR profile to locate/validate the preimage and
make an admission decision. Both candidates have been independently consumed by
Go's CBOR implementation and standard-library Ed25519; this is format evidence,
not a second provider implementation.

**Library limits:** the inspected [go-cose algorithm implementation](https://github.com/veraison/go-cose/blob/main/algorithm.go)
supports legacy `EdDSA=-8`, not native `Ed25519=-19`; its
[hash-header helpers](https://github.com/veraison/go-cose/blob/main/headers.go)
exist but carry experimental documentation. A library adapter may be needed; do
not downgrade our algorithm to claim compatibility. No untested claim of turnkey
generic library support is made. The independent verifier uses existing
`fxamacker/cbor` plus Go crypto, not this library.

**Custom code:** adoption replaces the envelope-specific signing/parser path; the
common direct-payload COSE profile remains for Grants and other objects. Snapshot
writers use the common hash-envelope signer. Old prefix-input builders and
compatibility readers have been removed. Metadata,
canonicalization, trust, replay and history checks remain. The 74-line TypeScript
experiment is not a production implementation cost estimate: the value is shared
standard representation and tooling, not a promise of fewer validation lines.

## Evidence and remaining implementation gates

The TS suite verifies exact bytes, all top-level admission-field tampering,
forbidden/mutated headers, wrong keys/roles, payload/signature corruption, changed
snapshot parties/transfer/destination and resource rejection. It explicitly shows
that stripping the descriptor leaves a valid generic signature but fails RACR
verification. The Go consumer independently reconstructs signatures and descriptors
and rejects corrupt signatures, wrong keys/roles and changed carried preimages.
Neither test substitutes for current-consent or live-cutover integration tests.

```sh
bun run --cwd packages/hail-codec-ts scripts/evaluate-rfc9995.ts
bun run --cwd packages/hail-codec-ts test -- test/rfc9995-candidates.test.ts
bun run --cwd packages/hail-codec-ts typecheck
mise exec -- go -C packages/hail-codec-go test ./...
bun run --cwd apps/server test -- test/protocol-interop-vectors.test.ts
```

The original evaluation passed 548 TS codec tests, the Go suite and 48 provider
interoperability tests. Current implementation evidence is recorded below.

## Final implementation and preservation

The production envelope has protected labels 1, 4, 258 and 259 as in candidate B,
but its sole unprotected label is **`https://racrproto.com/ns/racr/preimage`**. The
experimental label is rejected. Both TS and Go writers use the new profile and
both live verifiers reject old direct-payload envelopes. Provider transport and
metadata admission use a 17408-byte carrier limit and a 16384-byte descriptor limit.
All existing consent, DID-role, replay, membership, body and deadline gates remain.

**Identity correction:** inspection of the actual repository confirmed that
`envelope_digest` hashes the deterministic descriptor (`payloadBytes`), not the
complete COSE representation. That identity is preserved. There is no mass
rehashing, ID rewrite or re-signing of retained envelopes. Other signed objects
keep their existing representation-digest domains.

The operator confirmed that the only deployed provider is new, with an admin and
one user, and no subscriptions, connections, Grants or messages. There is no old
message history to migrate. TS and Go therefore expose only their current
signing/inspection/verification APIs. Mailbox reads, status publication, delivery
work and account-history validation all use that same RFC 9995 envelope profile.
The superseded-reader APIs, snapshot prefix-signature fallback, and old-format
fixtures/tests have been removed. History validation itself remains necessary for
messages created under the current profile.

The final snapshot carrier keeps the existing closed six-field JSON artifact.
Its `signature` contains the full RFC 9995 COSE_Sign1 with empty unprotected map;
the existing `manifest` field supplies its exact external preimage. This avoids a
second manifest copy and preserves client artifact structure. It **does not**
claim the candidate binary-container size savings above. Portable v7 and managed
v8 manifest schemas are unchanged; the protected content types distinguish the
new signature profile. The 64-byte raw signature is superseded for live export,
stage and completion, without fallback. All live source-key, destination,
transfer, custody, generation, fence and owner/monitor checks remain required.

Database migration 0109 changes signature storage constraints to the current
128–1024-byte carrier range, without an exception for old raw signatures. It is
registered in the normal migration list. Current fixtures come from synthetic
provider exports. Candidate experiments now use those current fixtures too;
no old envelope/snapshot fixtures or legacy signature helpers are required.

## Cutover and rollback

The confirmed deployment has no old message/connection history to drain or
convert. Apply migration 0109 and deploy the current provider/client profiles;
existing accounts and keys stay in place. No deployment or account/data reset is
part of this implementation task.

Once current messages or snapshot artifacts are written, a plain rollback to the
old binary cannot read them. Roll back before new writes or use a rollback build
that supports the current profiles. The transactional SQL rollback refuses to
remove support for new signature rows; it never deletes them to pass. These are
forward data-preservation constraints, not reasons to retain the superseded readers.

## Implementation validation

- TS codec: 557 tests; source, test, generator and benchmark typechecks pass.
- Go: full codec suite, including independent current snapshot verification, passes.
- Rust: 13 unit tests and 5 process tests pass, including frozen provider snapshot
  verification and changed bytes/profile/signature rejection.
  CLI workflow regressions pass, including 41 two-provider transfer cases.
- Provider: full unit suite passes (498 tests). Tampered parties, consent, expiry
  and body descriptors with recomputed hashes still fail before candidate lookup
  or replay mutation. Wrong snapshot key, purpose, DID, transfer, destination and
  manifest bytes fail signature verification.
- After compatibility removal, nine disposable PostgreSQL suites pass: envelope
  persistence/delivery, connection federation, snapshot signature constraints and
  rollback, managed authorization, managed transfer/return, portable transfer/return,
  account access, public cutover evidence and serving history. Synthetic database
  fixtures use the current signature storage shape; full transfer tests exercise
  the actual cryptographic signatures and authority gates.
- Account-history schema matches migrated export projections; CDDL consistency,
  current conformance vectors and `git diff --check` pass.

Tests use isolated local databases and public synthetic fixtures. The ordinary
unit run skips database suites; the dedicated integration runner executes selected
suites in fresh databases and treats skips as failures. This is local conformance
and preservation evidence, not evidence of production rollout or an independently
implemented full provider.
