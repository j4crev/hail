# Logical account history: portable v11 and managed v12

Status: Current alpha record schema, derived from the implemented collectors and
validated against synthetic exports. Versions 11/12 replace 9/10 and add logical Sent groups and dispositions,
alongside saved drafts and mailbox preferences. [Transfer formats](transfer-formats.md) defines its carrier,
signatures and ceremony; this document defines the history inside it.

## Storage independence

The normative machine-readable shape is
[account-history-v11-v12.json](schemas/account-history-v11-v12.json), JSON Schema draft 7.
It defines both manifests, both checkpoint domains, every exported record field,
field presence, scalar/array/object types and nullability. The schema is self-contained;
no database, ORM, TypeScript module or external schema fetch is required to use it.

`tables` is the historical wire name for a map of **logical record collections**.
An implementation MAY store them in documents, objects, a key-value store or SQL.
It MUST preserve the field names and semantics on this wire profile. Account/row
UUIDs are source-assigned correlation identifiers, not instructions to allocate
physical tables or reuse a source database primary key. An importer may map them
to internal keys if it preserves all original references and signed evidence.
The schema's `x-reference-storage` and `x-record-key` annotations explain the
reference mapping; they do not require that storage layout.

Do not translate signed protocol objects into reconstructed payloads. Preserve
original COSE, PLC operation and retained evidence bytes. Storage independence
changes storage representation, not historical identity, authority or signatures.

## Signature profiles in history

Stored envelopes and snapshot signatures use the same RFC 9995 profiles as new
objects. There is no reader for the superseded direct-payload envelope or raw
snapshot signature. The [namespace cutover](encoding.md#protocol-namespace-cutover)
requires the protocol-domain preimage label for both current and imported envelopes;
no old-label compatibility reader is defined. Original accepted bytes still must
be preserved, not normalized or re-signed.

History verification still MUST preserve original signed bytes and use the
corresponding key/authority evidence. Do not re-sign or normalize accepted objects.
The envelope identity remains SHA-256 of the descriptor bytes. Verifying history
does not restore consent or authorize a new action.

## Value and size rules

- Every manifest, collection map and record has a closed set of required fields.
  Nullable fields are present with JSON null; absent and null are distinct.
- Numbers are safe integers. Reference exports use JSON numbers for SQL integers,
  including bigint; a numeric string is not the current export representation.
- UUIDs are lowercase hyphenated text; DIDs, service bases, addresses and key
  identifiers follow their own protocol syntax and authority rules.
- Database-origin binary fields use the wire text `\x` followed by lowercase hex
  pairs. This spelling is retained for byte compatibility, not a SQL requirement.
  Never infer binary content from arbitrary strings. The schema identifies the
  binary fields; embedded CBOR signed objects still use native byte strings.
- Record timestamps are RFC 3339 strings, including fractional seconds and numeric
  offsets. Retain their text when hashing a checkpoint. Do not silently normalize
  `+00:00` to `Z`, round microseconds or convert timestamps into integers.
- Nested JSON evidence is a retained JSON value, not an extensibility slot for the
  containing record. Its authority is checked under the named PLC/consent profile.
  JSON Schema shape validation alone never proves a signature or current authority.
- The complete decoded manifest is 1–67108864 bytes. Checkpoint CBOR hashing permits
  at most 67108864 bytes, depth 32, 2000000 items, 100000 array elements,
  256 map entries, 16777216 text bytes and 1048576 native byte-string bytes.
  The outer completion request limit is 100000000 bytes. Fail closed when history
  exceeds a limit; there is no truncation, pagination or lossy fallback profile.

The manifest signature covers its exact saved JSON bytes. Checkpoint hashes cover
deterministic CBOR of the complete logical checkpoint object. Hex byte strings in
records remain **text** in that CBOR input. Do not decode them before hashing.
Array order is part of the digest. A peer need not reproduce the source's SQL
query order to verify a received snapshot: it preserves the received order.
Object key order matters for exact manifest JSON bytes but not for deterministic
CBOR checkpoint encoding.

## Record selection and scope

Both custody profiles include all common collections below. Portable adds
`portable_custody_evidence`; managed adds `managed_custody_evidence`. The enclosing
schema enumerates the complete table domain; missing empty collections are invalid.

| Collections | Logical meaning and selection |
| --- | --- |
| `provider_accounts` | Exactly one active account matching manifest account ID/DID; no closed/released address markers |
| `account_keys` | Source public role metadata only: portable rotation/messaging; managed rotation/identity/messaging; never encrypted private keys, nonces or KEK identifiers |
| `portable_custody_evidence`, `managed_custody_evidence` | Exact corresponding owner/recovery, custody and assurance evidence for that account |
| `plc_operation_evidence` | The account's retained signed PLC operations, lifecycle states and evidence |
| `address_bindings`, `sender_profiles` | The account's original signed identity/profile publication history |
| `grant_lineages`, `grant_revisions`, `grant_consent_evidence` | Owned and received Grant lineages, revisions and consent evidence; include co-located received Grants as local role `grantee` |
| `grant_publications` | Publication obligations for owned revisions; preserve acknowledgements, predecessor/ETag and retry state |
| `detached_bodies`, `body_authorizations` | Sender-owned exact body bytes and recipient/message-specific hashed-token authorizations |
| `sent_envelopes`, `received_envelopes` | Exact signed envelopes and durable per-envelope metadata, including authorization mode, parents and shared logical identity |
| `reply_capabilities` | Capabilities issued by this DID, their single-use claim/consumption state and exact original message references |
| `delivery_work` | Pending/terminal receiver work for this account's received envelopes and retry state |
| `verified_body_provenance` | Verified recipient-and-sender scoped body bytes; exports reconstruct the bytes even when local storage deduplicates blobs |
| `delivered_messages` | This DID's durably delivered message references, read markers and original Trash timestamps |
| `account_message_drafts` | All saved drafts, including Trash, with exact editable content, revisions and original timestamps |
| `account_publications`, `publication_targets` | Sealed category-send intents and complete terminal recipient audiences; retain original generation, body bytes and retry identity |
| `account_sent_dispositions` | Logical Sent Trash timestamps and permanent-deletion tombstones, including category, connection and individual sends |
| `account_message_preferences` | Zero or one owner-scoped Trash and display preferences record |
| `delivery_status_payloads`, `delivery_status_wrappers` | Immutable status revisions and signed wrappers for received deliveries |
| `terminal_status_publications` | Retained terminal-status publication obligations |
| `sent_delivery_status` | Recipient-signed status received for this DID's sent envelopes |
| `public_plc_resolution_evidence` | Exactly the immutable evidence bundles referenced by the enclosing account authority links |
| `public_envelope_authority_evidence`, `public_grant_authority_evidence`, `public_signing_authority_evidence` | Account-scoped links from exact representations/actions to historical authority decisions |

The ordinary collections are ordered by their stable IDs/revisions in the reference
exporter. Co-located received Grant blocks follow the owned Grant blocks; consumers
MUST NOT assume the concatenation is globally sorted. Portable bindings are ordered
by ID; managed bindings by creation time then ID. These are producer choices,
not alternate signature canonicalization algorithms.

The two current profiles have real field differences, captured by separate schema
definitions: portable public-key metadata includes `encryption_version`, managed
omits it; managed publication/delivery/status work omits `lease_token` and
`lease_expires_at`, whereas portable retains them. These fields are historical
metadata, not destination worker ownership. Destination activation MUST establish
its own execution ownership and serving generation. Do not transfer live sessions,
credentials, passkey secrets, source operational private keys or reusable invitation
bearer secrets. They are outside the declared collection/field domains.

Received read/Trash state, saved drafts and mailbox preferences are explicit
parts of this profile, together with logical Sent groups and dispositions.
Shared-conversation introduction policy, leave state and replay evidence remain
included because they affect delivery authority.

## Sent preservation in portable v11 and managed v12

Both profiles require `account_publications`, `publication_targets` and
`account_sent_dispositions`, including explicit empty arrays. Category publication
IDs remain distinct from their per-recipient message IDs. Connection-send groups
continue to travel in their connection/conversation checkpoints. Do not flatten
either group into individual Sent entries.

A category publication MUST belong to the migrating account and DID, be sealed,
and contain between 1 and 100 distinct recipient targets. Its original serving
generation MUST be positive. Generations belong to their original serving provider;
do not compare a retained generation with another provider's local epoch. Retain
original body bytes, request digest, reply deadline, creation/expiry/cancellation
timestamps and every recipient message ID. Verify the request digest as SHA-256
of deterministic CBOR `{category, body: body_bytes, allowReplies: reply_until != null}`.
Targets MUST be terminal (`submitted`, `blocked`, `cancelled`, `expired` or
`indeterminate`); pending work prevents cutover. Each target's retained Grant
must name the migrating DID as grantee and that recipient as grantor. A submitted
target requires its exact sent envelope; any existing envelope must agree with
the target's recipient, Grant, category, reply permission/deadline and body digest. Preserve required body
attachments using the existing attachment-history rules.

A disposition references exactly one logical send of its declared kind. An
individual-message disposition cannot reference a member of a group. Preserve
its original `trashed_at` timestamp and `deleted` flag; migration does not renew
retention. On return, the current snapshot replaces mutable Sent dispositions,
but MUST retain earlier permanent-deletion tombstones unchanged. Restoring an
ordinary trashed send is allowed. Never resurrect a deleted group through its
retained per-recipient envelopes.

Import is atomic with Grant/envelope/checkpoint restoration and generation change.
Original publication intents and audiences are immutable; a retained copy on a
returning provider must agree exactly. Sent timestamp comparisons use the same
instant to microsecond precision, allowing equivalent RFC 3339 timezone spellings;
signature verification still uses the untouched manifest bytes. Imported terminal targets MUST NOT be
requeued. Retrying a category publication ID with the same intent from the active
new generation returns its retained status; different intent fails. History does
not provide fresh consent or permission to send to the old audience again.

## Draft preservation in portable v11 and managed v12

Both profiles require `account_message_drafts` and `account_message_preferences`,
including explicit empty arrays. Draft records are closed and owner-scoped; IDs
are unique UUIDv7 values, revisions are positive 32-bit integers, timestamps are
RFC 3339 strings, and content follows [the editable draft contract](provider-drafts.md).
Preserve incomplete text, embedded images, builder fields, selected recipients,
forward references, attachment metadata and revisions exactly. Reject malformed
content, foreign owners, duplicate IDs and IDs already used by sent envelopes.

Every draft attachment requires the migrating account's `attachment_uploads`
record and matching `attachment_blobs` bytes. Verify digest, size and media-type
validation, even if the file was never sent. Missing files fail export/validation;
never silently strip them. The existing snapshot size bound still applies: an
oversized export fails rather than dropping drafts or files. No new upload access
is granted to other accounts.

Forward and recipient references preserve editable selections, not new delivery
or reading authority. A reference may already be unavailable or inactive when
saved. Migration does not recreate a deleted source message or grant consent to
reactivate a recipient. Clients must surface unavailable references, and sending
must revalidate them under the current provider's normal authorization rules.

The current complete snapshot is authoritative for drafts and preferences on a
return trip. Replace retired live drafts/preferences atomically; do not union them
with retired data. Drafts deleted or consumed at the other provider remain absent.
Preserve original Trash timestamps, including expired entries until cleanup, and
never restart retention. Import never signs, queues or sends a draft. Snapshot
signatures and owner-approved snapshot digests cover these collections; the separate
managed protocol-history checkpoint is not a substitute for that snapshot binding.

Activation retries are idempotent. A failed activation rolls back the draft and
preference replacement with the rest of the account. JMAP identities and cursors
reset with the destination serving generation; draft UUIDs, revisions and content
do not. Superseded snapshot versions are not accepted by current signed import
paths; pre-launch snapshots must be regenerated with matching source software.

## Received mailbox state on a return trip

A current, fully validated and authorized transfer snapshot is authoritative for
which received mailbox copies still exist. This applies to both managed and
portable return trips. `delivered_messages` rows may be absent because the user
permanently deleted them or retention removed them while using the other provider.
The returning provider MUST NOT reconstruct those copies from its retired export.
For surviving copies, the current `is_read` and original `trashed_at` values win;
import MUST NOT restart the Trash retention period. Destination-local arrival
cursors are not immutable message content.

Received cached body provenance may likewise disappear after its last mailbox
reference is deleted. A surviving received copy MUST still have its required
verified body provenance. If a previously retained cache row is present in the
current snapshot, its immutable content and ownership fields MUST agree with the
retired record. Shared bodies needed by other surviving copies cannot be dropped.

This rule does not permit deletion or alteration of signed received envelopes,
Grant history, delivery responsibility, terminal outcomes or delivery/status
proofs. Those retain their existing continuity checks. The archived export remains
immutable; activation replaces the live mailbox projection with the current
snapshot atomically, including when activation is retried after a lost response.
It does not merge retired mailbox copies back into the account.

These semantics use the existing received-message/cache collections and fields;
they do not by themselves claim Sent-state portability. Draft preservation is
defined separately above.

## Connection checkpoint v3

The checkpoint is exactly `{type,version,accountId,did,sourceGeneration,
sourceServiceBase,capturedAt,sharePolicy,tables}` with type
`hail.connection-history`, version 3 and `sharePolicy:"invalidate-at-cutover"`.
Owner, generation, service base and capture time MUST match the enclosing manifest.

| Collections | Preserved semantics |
| --- | --- |
| `connection_invitations`, `connection_approvals` | Historical invitation and owner-approved consent evidence only; source share codes are invalidated at cutover, not imported as active credentials |
| `account_connections` | Retained native pair IDs, party DIDs/generations, signed consent and terminal history |
| `federated_connection_pairs`, `federated_connection_attempts` | Pair/coordinator location, epoch, exact admission bundles and durable results |
| `federated_connection_events`, `federated_connection_results` | Coordinator events and their causal signed commands/results |
| `federated_connection_tombstones` | Terminal connection IDs/epochs; a later import cannot reopen one |
| `federated_connection_disconnects`, `federated_connection_outbox` | Completed disconnect and replication evidence; unfinished work cannot be discarded to permit a fence |
| `federated_connection_signatures`, `public_plc_resolution_evidence` | Exact controls and their historical signing decisions/bundles |
| `connection_message_batches`, `connection_message_targets` | Sealed private connection-message intent, body/audience and terminal per-recipient results |
| `connection_handover_barriers`, `connection_import_handovers`, `connection_transfer_aborts` | Retained authenticated peer freezes, transitions, releases and exact owner cancellation history |

The explicit projections in the schema omit admission token ciphertext/nonces and
session/passkey challenge state. The history may retain old consent formats as
historical evidence, but new admission uses the current coordinator protocol.
Terminal history is not converted into a fresh connection or a new epoch.

## Conversation checkpoint v1

This is exactly `{type,version,accountId,did,sourceGeneration,sourceServiceBase,
capturedAt,tables}`, type `hail.conversation-history`, version 1. It has a separate
digest; do not merge it into or change the connection-v3 digest domain.

| Collections | Preserved semantics |
| --- | --- |
| `account_conversation_preferences`, `connection_conversation_preferences` | Explicit global/per-connection introduction overrides; absence retains the default, not an invented explicit override |
| `conversation_descriptors` | Immutable signed descriptor, exact representation hash, roster, timestamps and historical signing evidence |
| `conversation_memberships` | Admission, expiry, last reply activity and manual leave state |
| `connection_message_batches`, `connection_message_targets` | Sealed shared-message intent, body, complete roster audience and terminal per-recipient delivery results |
| `public_plc_resolution_evidence` | Exactly the descriptor signing-evidence bundles referenced by this checkpoint |

A membership's stored state is `active` or `left`. `expired` is derived from
`expires_at`, not a third stored enum. Leave requires a retained `left_at` value;
active requires null. Importing expired history MUST NOT reset the lease.
Each descriptor belongs to an account membership and includes the owner DID in
its roster. The descriptor identity is `(creator_did,conversation_id)` and its
hash covers complete signed bytes. Shared batch targets belong to that fixed
roster; a submitted target references its exact sent envelope and logical ID.
Connection/checkpoint batches are partitioned by whether conversation context is
present; an importer must not duplicate a shared batch into the private domain.

Current source preferences and memberships replace stale mutable destination
state on return. An absent source membership cannot reactivate an old destination
grant. Preserve original admission time and descriptor identity while updating
source-authoritative expiry/activity/leave state. Existing immutable evidence with
conflicting bytes is an error, not a last-write-wins merge.

## Mandatory semantic validation

Schema validity is necessary but not sufficient. Before staging and activation:

1. Verify the exact manifest digest and source signature, the source's current or
   retained authorized signing decision, exact destination keys/intent, owner
   approval and matching custody profile. Current PLC cutover and monitor gates
   remain separate from archived proof verification.
2. Match every owner-scoped record to the manifest account/DID. Correlation IDs
   referring to other parties do not authorize importing their accounts. Reject
   future serving generations, duplicate logical keys and missing dependencies.
3. Check each Grant revision's original COSE, full representation digest and
   predecessor/current pointer; consent/publication rows reference retained
   revisions. Do not re-sign or recreate Grants as a migration repair.
4. Validate exact body profile bytes and SHA-256; body authorizations reference
   the correct sender-owned body. Received cache provenance remains scoped to
   both recipient and sender, even if physical blob storage is shared.
5. Verify every envelope's signature/history and exact payload digest, parties,
   message ID and stored authorization metadata. Shared envelopes require the
   exact descriptor in the conversation checkpoint. Connection envelopes retain
   the exact connection ID/epoch. Submitted targets cannot lose their envelopes.
6. Bind each delivery/status record to its original envelope. Preserve monotonic
   revisions, terminal results and immutable status payloads. A wrapper's payload
   must equal the retained revision. Reply claims reference the original signed
   invitation and accepted reply; no duplicate available capability is created.
7. Validate all checkpoint hashes and signed-object linkage. Verify historical
   identity/messaging authority using retained PLC chains and current canonical
   history; a nullified branch or missing authority evidence is rejected. A valid
   archived key does not become today's authority.
8. Preserve terminal connection IDs, coordinator epochs and complete local consent.
   Require drained admissions/disconnects/replication and terminal message
   batches before export. Peer handover is required before a new provider may
   activate nonempty connection history. A snapshot alone cannot move location pins.
9. Preserve leave and lease timestamps atomically with import.
   Validate immutable shared-message intent.
   Never derive permission from possession of a descriptor or conversation ID.
10. Activate only after the fenced source snapshot, owner PLC cutover, destination
    import, peer handover and observation gates all agree. Repeated import must
    preserve bytes and outcome; timeout/expiry never independently releases the
    source fence. Fresh destination login/credentials are separate.

These requirements are exercised by the existing transfer, connection-history,
conversation reconstruction and historical-authority tests. The published vectors
add independently reproducible representation and rejection checks; they do not
replace live authority, concurrency or recovery tests.

## Managed history checkpoint digest

Compute SHA-256 over deterministic CBOR of this map, preserving source array order:

- `type:"hail.managed-migration-history-checkpoint"`, `version:1`, `did`,
  `source_generation`, `connection_checkpoint_digest`, `conversation_checkpoint_digest`.
  Both component digest fields are the manifest's base64url **text**, not bytes.
- `plc`: for each PLC evidence row, `{id,operation_cid,previous_cid,state,
  dag_cbor_sha256}`. Use `previous_cid` or empty string; `state` is
  `submission_state`; the final field is base64url SHA-256 of decoded `dag_cbor`.
- `grants`: for each revision, `{grant_id,revision,status,digest,signer,
  publication,etag}`. Digest is base64url decoded `representation_digest`;
  signer is `signing_public_key`; publication/etag come from the matching
  `(grant_id,revision)` publication, defaulting to `"none"` and `""`.
- `bindings`: `{id,digest,selected_at,published_at}` for each binding. Digest is
  base64url decoded representation digest; absent timestamps become `""`.
- `authority`: `{did,operation_cid,evidence_digest,bundle_sha256}` for each
  resolution row; digest fields are base64url decoded evidence digest and
  SHA-256 of decoded bundle bytes respectively.
- `authority_links`: concatenate envelope links, Grant links, then signing links;
  project `{authority_did,representation_digest,evidence_digest}` and convert
  both digest values from wire hex to base64url text.

Store the resulting hash as base64url `historyCheckpointDigest`. This digest
supplements rather than replaces the signed exact manifest digest.

## Implementation evidence and drift protection

The schema was extracted from the fully migrated reference database and the
actual collector projections. `scripts/export-account-history-schema.ts --check`
creates a fresh disposable database, applies migrations and detects mapping drift.
It never reads account data from the supplied administrative database. Actual
portable/managed exports and nonempty connection/conversation checkpoints are also
schema-checked by integration tests. Updating a database column does not implicitly
amend the protocol: review the projection/schema and vectors in the same change.

[Conformance vectors](vectors/README.md) include fixed actual synthetic exports,
nonempty collected checkpoints, complete signed transfer/handover records and
connection HTTP bodies. TypeScript exercises the real server validators;
Go independently decodes, hashes, verifies signatures and validates record shapes
without importing the server implementation. This establishes cross-language
format evidence, not a claim of a second independently deployed Hail provider.

## Detached attachment records (current alpha)

The current v11/v12 manifests additionally require `attachment_blobs`,
`attachment_uploads`, `body_attachment_refs`, and `received_attachment_refs`.
Empty collections are explicit. See the regenerated closed JSON schema for
fields. Blob bytes and digests use the existing PostgreSQL hex-byte diagnostic
representation. Logical records do not prescribe a physical deduplication backend.
Import verifies every body's required file reference and bytes, not merely that
some matching digest exists globally. Owner fields must match the migrating
account/DID; received references also match sender, media type, and body profile.
Foreign or unowned blobs and incomplete references are rejected. This is a
breaking pre-launch format expansion: regenerate older snapshots with matching
source software. Do not drop files to fit the existing bounded snapshot budget.

Provider-local resource accounting (`received_envelopes.admission_bytes`) and
queue fairness history (`delivery_scheduling`) are excluded from both
portable and managed snapshots. The target recomputes byte accounting and starts
its own fair scheduling history; signed envelopes, replay decisions, attempts,
and retry deadlines remain in the existing history representations.

## Provider-local retrieval replay state

`body_request_nonces` is not logical account history and is not exported. Keep
unexpired nonce state at its serving origin across restarts and account transfers.
Changing sender origins requires fresh target-bound signatures; replacing storage
at the same origin requires preserving replay state or the quarantine described
in [retrieval signatures](retrieval-signatures.md#retry-rotation-and-migration).
