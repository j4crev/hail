# Phase 5: JMAP synchronization and operations

The current alpha profile uses [RFC 8620 JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html)
for client/provider discovery, method calls, object state and binary access. Hail
extensions define the data and authority rules. It does not implement RFC 8621
Email/Mailbox or claim compatibility with generic JMAP Mail clients. Events and
Web Push remain phase 6; polling and recovery work without notifications.

## Implemented profile

- [Transport and received messages](../spec/jmap.md): authenticated Session,
  bounded requests/batches, result and creation references, exact-byte downloads,
  binary uploads and same-account Blob/copy; message get/query/changes/set.
- [Drafts](../spec/jmap-drafts.md): content/revision checks, Trash, send consumption
  and durable change tracking, retaining the existing browser-session policy.
- [Account collections](../spec/jmap-collections.md): Sent, submissions, Grants,
  and relationships. Relationship metadata includes invitations, pending attempts,
  unseen state, introduction preferences and conversation membership, never raw
  invitation secrets. Collection IDs and states bind provider/account generation.
- [Typed operations](../spec/jmap-operations.md): mailbox presentation and cleanup,
  submissions, exact signed Grants, owner approval, connections and attachments.
  These call existing services directly; no HTTP path tunnel or legacy fallback.

Writes from clients, federation, retention and migration update durable logs in
transaction with their data. Collection states serialize snapshots and conditional
writes. Logs retain at least 30 days (the provider uses 31); expired/foreign states
require a fresh snapshot. Browser polls commit their cursors only after all
collection reads succeed. CLI inbox waits use received-message changes and local
sender filtering; no initial backlog is implied when no state is supplied.

Submissions retain durable account-scoped IDs, immutable body/audience intent and
exact signed artifacts across ambiguous responses. Acceptance, batch completion
and recipient delivery remain distinct. Login and JMAP calls do not substitute
for owner signatures or exact managed approval. Existing scope/fence checks stay
in the domain services.

## Accepted portability requirement

Read/unread state and drafts are mandatory on provider migration. Trash was
requested too and is included: no omission was necessary. Portable v11 and managed
v12 preserve saved drafts and referenced uploads, mailbox preferences, received
read/Trash/deletion state, logical category-send groups and Sent dispositions.
Original Trash timestamps and permanent-deletion tombstones survive return trips;
imports never send drafts or restart completed sends. Signed CBOR/COSE bytes remain
unchanged. A new provider/generation resets synchronization IDs and caches, not
preserved user data. Sessions, API credentials and unreferenced temporary Core
uploads are provider-local and are not account history.

The generated history schema, actual signed synthetic export vectors and TS/Go/Rust
readers use the current formats. Portable round trips include nonempty category
Sent groups, restore/delete and exact-intent retries after returning. Managed round
trips exercise the shared import contract alongside received mail and drafts.

## Replacement and rollout

The operator authorized removal of obsolete APIs during alpha; no deployed mailbox
history required an adapter. Superseded mailbox, submission, Grant, connection and
permission routes are removed with their GUI/CLI callers. Migration 117 removes
the delivery-only cursor column, sequence and trigger. Migration 114 carries Sent
history; 115 adds temporary Core blobs; 116 adds provider-local synchronization
projections. Apply current migrations with the matching provider and clients.
Rollback scripts preserve domain history; unexpired Core uploads prevent rolling
back their table. No database wipe or credential/account reset is involved.

Account inspection, credentials, identity/profile, login/recovery, transfer,
administration, federation and protected media downloads retain distinct resources.
Their continued existence is intentional, not legacy mailbox compatibility.

## Verification and limits

Coverage includes PostgreSQL collection isolation, paged two-reader convergence,
rollback, retention, generation reset, explicit/deferred refresh lock ordering,
Core binary access, signed Grant consent, connections and shared-conversation
lost-response retries; real HTTPS CLI compatibility and two-provider transfer;
web state recovery and authorization fixtures; and independent Go/Rust signed
history readers. The source suites are under `apps/server/test`,
`apps/client/src/lib`, `apps/cli/tests`, and `packages/hail-codec-go`.

The reference provider refreshes derived account metadata at transaction completion.
Large-account performance has not been benchmarked. Third-party provider/client
certification is not claimed. Web Push, event streams, generic JMAP Mail and
cross-account blob sharing are outside this phase's implemented profile.
