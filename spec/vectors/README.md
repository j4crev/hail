# Current protocol conformance vectors

`experimental-rfc9995.json` is explicitly **not current protocol conformance**.
It records the [phase 2 candidate evaluation](../../agents/standards-phase-2.md),
including exact signature inputs, public synthetic signing keys and size evidence.
The TS `rfc9995-candidates.test.ts` and Go `rfc9995_candidates_test.go` consume it;
production codecs reject these experimental representations, including their
experimental extension labels. Regenerate only deliberately
with `bun run --cwd packages/hail-codec-ts scripts/evaluate-rfc9995.ts`.

`content-digest.json` freezes HTTP digest dictionary acceptance/rejection cases
over exact `contentHex` bytes. The server's `content-digest.test.ts` consumes it;
body and attachment retriever tests separately prove that matching transport
digests cannot bypass signed content checks. These are HTTP profile vectors, not
new signed CBOR formats or evidence of an independent HTTP implementation.

These are public synthetic fixtures. They contain test signatures, key identifiers,
bearer capabilities and message content. Never use their keys, tokens or identities
for a real account. No production account or hosted database was read to create them.
Normal tests read committed files; they do not generate their own expected bytes.

## Artifacts and provenance

| Artifact | Actual producer and coverage |
| --- | --- |
| `cbor-resource-limits.json` | Synthetic exact CBOR boundaries for default depth, item, array, map and encoded-byte budgets; small override cases isolate map-key counting and UTF-8/byte-string lengths. Segments expand to fixed bytes checked against committed length and SHA-256 in both codecs. These are data-model tests, not valid signed Hail objects. |
| `portable-history.json` | `MigrationTransferService.exportFenced` in the private-PLC transfer/return integration test; v11 with Grants, consent, accepted and delivered messages, body provenance, immutable statuses and retry obligations |
| `managed-history.json` | `ManagedMigrationExportService.exportFenced` in the managed network orchestration integration test; v12 with public source role metadata, managed custody, Grants, detached body authorization and pending delivery |
| `connection-history.json` | `collectConnectionHistory` after real local connection admission in the shared-conversation integration test; nonempty pair, proof, result and signing-evidence history |
| `conversation-creator.json` | `collectConversationHistory` after shared sends; immutable descriptor, creator membership and terminal shared-message outboxes |
| `conversation-active.json` | Same collector for an active recipient whose own reply renewed their participation |
| `conversation-left.json` | Same collector for a recipient who left and disabled introductions; exact leave and opt-out state survive reconstruction |
| `transfer-wire.json` | Real portable/managed signing functions, handover signing functions and wire wrapper; 34 fixed Ed25519/ES256 records (including split-domain portable and managed grants), all handover signature roles, consent, activation and cancellation |
| `connection-wire.json` | Real COSE codec; coherent invitation, confirmation, address bindings, reviewed coordinator snapshot and deterministic bundle, lifecycle/ack controls, conversation descriptor, exact JSON request/response bodies and ingress rejection cases |
| `history-negative.json` | Shared mutation instructions for unknown/private fields, missing domains, wrong scalar types, foreign ownership and changed checkpoint digests |

Current codec envelope vectors in `packages/hail-codec-ts/vectors/` use the
production RFC 9995 descriptor profile, with exact wire and signature inputs.
Current snapshot fixtures carry complete RFC 9995 COSE in `signatureHex`; the
manifest is an external preimage. TS/provider, Go and Rust consumers verify the
current formats. Superseded envelope and snapshot fixtures are not maintained.

Snapshot fixtures retain exact manifest bytes in `manifestBase64`, source public
key, signature and expected digest. JSON objects displayed after parsing are not
replacement signed representations. Checkpoint fixtures contain the exact logical
object and expected deterministic-CBOR SHA-256. Transfer records include
schema-aware diagnostic values (`{"$bytes":"hex"}` is a fixture-only byte marker),
payload hex, digest, signature input hex, signature, public key and signed-record
wire object. `$bytes` is not a RACR protocol field.

Portable/managed fixture generation uses isolated synthetic databases and injected
PLC/HTTPS dependencies. Their retained evidence does not claim public PLC registry
membership. Transfer-wire digest subjects and PLC CIDs marked as placeholders test
encoding, signatures and linkage only; they are not admissible live cutover proof.
Receiver freshness is evaluated at the fixture's `time` where applicable.

## Independent verification

Run from the repository root:

```sh
bun run --cwd apps/server test -- test/protocol-interop-vectors.test.ts
bun run --cwd packages/hail-codec-ts test -- test/resource-vectors.test.ts
mise exec -- go -C packages/hail-codec-go test -run 'Test(AccountHistory|TransferWire|ConnectionWire)Interoperability|TestPublishedHistoryRejections' ./...
mise exec -- go -C packages/hail-codec-go test -run TestPublishedResourceBudgets ./...
```

TypeScript calls the actual server decoders/verifiers and manifest/checkpoint
validators. Ajv validates the published JSON Schema. HTTP tests exercise the real
connection ingress parser, with a service double isolating transport from database
authority; the existing database suites exercise the real state transitions.

Go imports no server code. It independently encodes checkpoint/handshake CBOR,
computes exact JSON and CBOR digests, reconstructs the managed history projection,
verifies Ed25519 and P-256 signatures using Go's crypto, checks COSE using the Go
codec, checks closed wire shapes and rejects duplicate JSON keys. A test-only
schema evaluator covers exactly the JSON Schema vocabulary used by this artifact;
unknown vocabulary is an error. It also loads records into in-memory collections,
with no SQL dependency, and checks ownership/checkpoint linkage. This is an
independent format consumer, not a complete second provider or live PLC verifier.

Both consumers run the published history rejection cases. Additional checks reject
changed signatures, substituted signature purposes, incorrect byte digests and
manifest reserialization (even adding whitespace changes the signed digest).
Existing codec vectors separately cover full CBOR/COSE malformed forms and
conversation roster/schema constraints in both languages.

## Schema drift and actual export checks

```sh
DATABASE_TEST_ADMIN_URL=<disposable-postgres-admin-url> bun scripts/export-account-history-schema.ts --check
DATABASE_TEST_ADMIN_URL=<disposable-postgres-admin-url> bun scripts/test-database-integration.ts private-poc-migration managed-network-orchestration server/test/shared-conversations.integration
```

The schema check creates and drops its own fresh database, applies every migration,
and compares the export projections to the committed schema. Integration tests
validate actual new exports/checkpoints against that schema and perform their
existing staging, cutover, return and conversation reconstruction assertions.
CI runs the schema drift check, ordinary TS/Go vector tests and database suites.

## Deliberate fixture maintenance

To update signed wire examples using fixed public test keys:

```sh
bun apps/server/scripts/generate-transfer-vectors.ts
```

To capture new history examples, set `HAIL_WRITE_HISTORY_VECTORS=1` on the three
isolated database suites above. Only test code honors this opt-in. Capture is not
byte reproducible: the real account workflows generate fresh IDs, timestamps and
keys. Once captured, expected bytes are frozen and reviewed. Do not regenerate
fixtures during ordinary verification or change expected digests merely to make
a failed test pass. Record schema/version changes and inspect the affected data.

The passing corpus is evidence for the cases represented here. It does not prove
all recovery races, resource-exhaustion behavior or a third-party deployment's
correctness. Those require the separate state-machine, database, authority and
operational conformance tests.

`provider-drafts.json` covers the provider-local draft content format, including
incomplete input, forwarding references, audience constraints and UTF-8 budgets.
It is not signed federation evidence. `apps/client/src/lib/drafts.test.ts` executes
these examples against the shared parser.

`attachments.json` freezes one SPT-2 detached LOG declaration, its CBOR and body
digest, and exact file bytes. TypeScript and Go both verify the encoded body.
The portable/managed history vectors were recaptured for migration 102's current
alpha schema expansion and contain a received/outgoing attachment respectively,
including verified file bytes and owner references, from actual round-trip tests.

`attachment-png.json` freezes a non-animated PNG attachment, including exact file
bytes, the authenticated SPT-2 declaration, body CBOR, and body/file digests.
TypeScript and Go verify the same declaration bytes; provider tests verify PNG
structure separately from the message-body and bundled-header budgets.

`attachment-images.json` freezes small baseline/progressive JPEG and static
lossy/lossless/transparent WebP files generated with ImageMagick, plus their
authenticated metadata and deterministic body encodings. Tests use these committed
bytes without requiring an image encoder or pixel decoder.

`provider-connections.json` defines accepted and rejected unseen-connection acknowledgment bodies for the reference-provider account API. Exercised by `apps/server/test/connections.integration.test.ts`; these are not federation wire objects.

## HTTP retrieval signatures

[retrieval-signature.json](retrieval-signature.json) is the deterministic
`hail-retrieval-v1` request, signature-base and Ed25519 vector. Its private seed
is public test material only. `retrieval-signature.test.ts` verifies its exact
bytes independently with Node crypto and WebCrypto; database/HTTP tests cover
replay, concealed failure, rotation and endpoint changes.

`jmap.json` defines executable Hail JMAP HTTP request/response vectors
for result references, capability opt-in, foreign account isolation, read-only mutation rejection and errors.
`apps/server/test/jmap-routes.test.ts` consumes these; database synchronization
and exact signed-byte carriage are exercised by `jmap.integration.test.ts`.

`jmap-drafts.json` defines executable draft capability routing and metadata-result
reference vectors, consumed by `jmap-draft-routes.test.ts`. Draft content schema,
transactional synchronization and cleanup are exercised by
`jmap-drafts.integration.test.ts`.

## Phase 7 evidence and limits

Verified locally on 2026-11-11 against implementation commit
`7f05efcbdde7775e108288bf9c210c5b56f607d2` and the accompanying publication-only edits.
The [current profile index](../README.md#current-profiles) owns versions; the
[encoding inventory](../encoding.md#publication-identifiers-and-registration-templates)
owns names and registration status. Existing frozen vectors were consumed, not
regenerated to make these checks pass.

| Execution | Result and what it establishes |
| --- | --- |
| `bun run --cwd packages/hail-codec-ts test` | 18 files, 557 tests passed; current encoding, signatures, resource limits, profiles and malformed-input rejection |
| `mise exec -- go -C packages/hail-codec-go test ./...` | Passed; independent Go codec and standard-library crypto consume the frozen representations, including hash envelopes/history and rejection vectors |
| `mise exec -- cargo test --manifest-path apps/cli/Cargo.toml snapshot` | One Rust snapshot test passed; current portable/managed hash profiles verify exact export bytes. Other CLI tests are outside this invocation |
| `bun run --cwd apps/server test -- test/retrieval-signature.test.ts test/protocol-interop-vectors.test.ts test/jmap-events.test.ts test/jmap-account-schema.test.ts test/safe-fetch-tls.test.ts` | 5 files, 63 tests passed; real provider decoders/crypto, HTTP signature base verified through Node crypto, event/schema boundaries and real TLS hostname checks |
| `DATABASE_TEST_ADMIN_URL=<disposable-admin-url> bun scripts/test-database-integration.ts retrieval-signature provider-authentication jmap-push jmap-core jmap-collections jmap-relationships private-poc-migration managed-network-orchestration` | 8 suites passed, no skips; fresh source/target databases per suite, using an isolated loopback PostgreSQL 18 container. Exercises persistence, replay/restart, account/credential boundaries, consent and transfer state transitions |
| `xml2rfc --text --html drafts/draft-creviston-racr-00.xml` (3.35.0) | Both retained renderings regenerated without warnings |
| `npx --yes @ietf-tools/idnits@3.3.0 --no-color --no-progress drafts/draft-creviston-racr-00.txt` | Passed with no nits |

Go/Rust are independent format consumers within this project, not independently
operated provider implementations. Node/WebCrypto checks do not establish
interoperability with an independently implemented RFC 9421 server. JMAP schema,
HTTP and database tests exercise the reference implementation; they do not certify
a generic JMAP Mail client or a third-party Hail client. Live public PLC cutover,
real-device push-service delivery, complete third-party federation and an external
security audit are not established by this run. The existing
[artifact provenance](#artifacts-and-provenance) and [synthetic fixture limits](#independent-verification)
continue to apply.

Publication review also checked exact signed content-type names against the TS/Go
profiles, snapshot purposes against TS/Go/Rust verification, and domain-controlled
JMAP capability names against server constants. No identifiers or wire formats
were changed in that initial preparation; the follow-up below records the later
namespace change. The [security review](../README.md#standards-profile-security-review)
records the reviewed threats and unresolved limits. Passing these checks does not
close external registration or the remaining historical-authority decisions.

### Protocol namespace follow-up

Current codec vectors (`v0.json`, `threads-v3.json`, `connections-draft.json`,
`conversations-v1.json`) are regenerated with their existing generators for
`https://racrproto.com/ns/racr/preimage`. JMAP request vectors use the protocol
capability namespace. TS/Go readers reject the old label, arbitrary provider
labels and maps containing both labels. There is no compatibility reader.

The operator confirmed no subscriptions, connections or messages require old-label
support. History vectors are deliberately recaptured through the isolated workflows
under [fixture maintenance](#deliberate-fixture-maintenance), using the current codec.
Their fresh IDs, timestamps, keys, exact manifest bytes and signatures are synthetic
exports, not transformations of previously authenticated evidence. Experimental
candidate vectors retain their original test-only formats; runtime codecs reject them.
See [cutover and rollback](../encoding.md#protocol-namespace-cutover).

The initial phase 7 validation above predates this namespace follow-up.

Validation after removing the unused compatibility reader (2026-11-11):

- `bun run --cwd packages/hail-codec-ts test` — 558 passed; codec typecheck passed.
- `HAIL_WRITE_HISTORY_VECTORS=1 DATABASE_TEST_ADMIN_URL=<disposable-admin-url> bun scripts/test-database-integration.ts private-poc-migration managed-network-orchestration server/test/shared-conversations.integration` — three suites passed without skips; recaptured portable/managed history and connection/conversation checkpoints from actual test exports. The isolated PostgreSQL 18 container was removed afterward.
- `mise exec -- go -C packages/hail-codec-go test ./...` — passed against the new fixtures, including retired/foreign-label rejection.
- `bun run --cwd apps/server test -- test/protocol-interop-vectors.test.ts` — 48 passed against the new exports.
- `mise exec -- cargo test --locked --manifest-path apps/cli/Cargo.toml snapshot` — snapshot verification passed.
- Draft rendering, idnits, Markdown links and namespace checks passed. All six captured history fixtures contain no retired envelope URI.

JMAP namespace behavior is unchanged from the preceding follow-up, whose web-client,
server-route and native HTTPS CLI checks passed. No production data was changed.
