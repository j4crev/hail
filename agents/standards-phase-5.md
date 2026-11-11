# Phase 5 implementation: JMAP synchronization and operations

Status: received-message reads, read/Trash state and deletion, plus draft reads/writes/synchronization implemented in [the JMAP profile](../spec/jmap.md).
Authenticated discovery, query/get, exact-byte downloads and transactional received-message
changes and state-conditional read/unread writes are covered by tests. The web
client uses JMAP for read/unread, received-message delete and restore; their old provider routes are
removed. [Draft reads and changes](../spec/jmap-drafts.md) now track saves, Trash,
cleanup and send consumption; draft writes and web editor/list/Trash callers now use JMAP, with superseded
draft HTTP routes removed. Return imports now preserve received-copy deletions
and allow cleanup of unreferenced received caches without losing signed evidence;
Portable v9 and managed v10 now preserve drafts, required attachment uploads and
mailbox preferences through return trips; Sent-state transfer remains pending.
Other objects, mutations, full Core
conformance, Sent-state transfer and remaining client adoption remain pending.
The checklist in [DESIGN](DESIGN.md#5-jmap-synchronization-and-operations) records that boundary. User-data portability below is an accepted product requirement; the
remaining engineering defaults are proposals pending the exact wire profile.

## Established direction

- Use [RFC 8620 JMAP Core](https://www.rfc-editor.org/rfc/rfc8620.html) with a RACR
  extension. This is the client/provider API; federation remains RACR.
- Define Hail messages, local presentation state, drafts, relationships, Grants
  and submission results. Preserve exact signed CBOR/COSE bytes in JSON carriage;
  a decoded projection does not become a replacement signed object.
- Reuse the existing account, mailbox and domain services. JMAP does not grant
  additional scopes, turn login into owner authority, or bypass exact approvals.
- Start with authenticated Session discovery and read-only message query/get.
  Implement durable changes and mutations before switching reference clients.
- [RFC 8621 JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html) defines an email
  data model; it is not automatically implemented by this extension. Existing
  email providers can integrate Hail without representing Hail as RFC 5322 email.
- Push and connected notifications belong to phase 6. Synchronization must work
  even when notifications are missing.

Sources: [JMAP direction](DESIGN.md#jmap-interoperability-and-notifications),
[baseline inventory](standards-baseline.md#5-jmap-synchronization-and-operations),
[client contract](../spec/client-api.md), and
[provider authentication](../spec/provider-authentication.md).

## Replacement policy: remove superseded account API machinery

The operator confirms one deployed provider, two accounts (including the admin),
and no messages or Grants. There is no requirement to preserve the old client API,
old cursors or compatibility fixtures for this deployment. Apply the existing
[pre-launch policy](haili-operations.md#pre-launch-development-policy--developers-and-agents):
replace each workflow and its reference-client callers together, then remove its
superseded routes, parsers, cursor code, documentation and compatibility-only tests
in the same change. No deprecation window, fallback adapter or dual API support
is required. Do not wait for unrelated phase 5 workflows to be finished before
removing an already replaced workflow.

Current audit: individual read/unread and web received-message Trash/restore/deletion are replaced; the remaining
mailbox workflows still need their JMAP replacements.

| Existing surface | Remaining dependency / removal condition |
| --- | --- |
| Per-message mark-read / mark-unread | Replaced by HailMessage/set; web callers, provider routes and compatibility-only route assertions removed. Shared read-state SQL remains a domain service. |
| Inbox/feed/message reads | Web mailbox loaders and CLI reads still call these; JMAP must supply the body presentation, subscription/connection selection and conversation/reply context those workflows use before their callers switch. |
| `/inbox/updates` | CLI polling still consumes the delivery cursor. Switch it to JMAP query/get/changes with equivalent filtering and recovery, then remove `inbox-updates.ts`, its route, cursor parsing and superseded cursor tests. Review delivery-sequence storage, triggers and transfer-schema references together before removing them. |
| Received-message delete / restore | Web callers use HailMessage/set with state and preference guards; old delete and bulk restore endpoints removed. CLI permanent-delete remains until its bearer workflow is replaced. |
| Sent/draft Trash, whole-account Empty Trash, aggregate conversation operations, relationships, Grants and submission | Draft reads/changes/authoring and draft Trash have JMAP replacements; the other workflows remain. Move each workflow and its tests before deleting its existing HTTP surface. |

Evidence: [web feed](../apps/client/src/lib/server/mailbox/feed.ts),
[message loader](../apps/client/src/lib/server/mailbox/message.ts),
[draft loader](../apps/client/src/lib/server/mailbox/drafts.ts),
[CLI polling](../apps/cli/src/poll.rs), and
[CLI conversation operations](../apps/cli/src/conversations.rs).

Shared mailbox/domain services, authorization and transactional change tracking
are current implementation machinery, not compatibility layers: delivery workers,
retention and transfer imports also write mailbox data. Keep their invariants and
move behavioral/security tests to the new API rather than deleting that coverage.
Provider login, owner approvals, administration and federation are not superseded
merely by introducing JMAP. Preserve the two accounts, credentials and identity/
recovery material. Use explicit schema changes to remove obsolete storage; this
decision neither authorizes a database wipe nor requires preserving old wire
formats. Draft/read-state portability remains a requirement for future migrations
even though the current deployment has no mailbox data.

## Engineering defaults to specify before coding

These do not need another product-direction decision, but must become an exact
profile, with schemas and method vectors, before advertising the capability.

1. **Account and record identity.** Use opaque account-scoped JMAP IDs; retain
   protocol sender/message identity separately. Define how received copies, sent
   mailbox entries and submission batches map to distinct objects. A UI Sent item
   can represent multiple per-recipient envelopes, so it must not be silently
   conflated with one signed message. Choose domain-controlled capability and
   method names under RFC 8620's extension rules; do not invent an IETF allocation.
2. **Immutable versus mutable fields.** Preserve signed envelope/body content;
   expose read state and Trash separately. Specify exact byte encoding and bounded
   binary access. Do not make a JMAP read trigger sender-side retrieval or mark
   the item read. Retain the existing account-isolation and private-cache rules.
3. **State and concurrency.** Track creates, updates and deletions durably, in
   the same transaction as the affected data. Cover existing HTTP handlers,
   delivery workers and background retention, not just new JMAP methods. Use
   state preconditions for conflicting writes and existing draft revisions.
   JMAP batches are not implicit transactions.
4. **Change retention.** Target at least 30 days of calculable change history,
   consistent with RFC 8620 section 5.2. Keep deletion records long enough for
   disconnected clients to converge. Expired/unrecognized states return the
   appropriate JMAP error and require a fresh snapshot. The existing inbox cursor
   tracks new deliveries only; it cannot represent updates or deletions.
5. **Submission retries.** Keep durable account-scoped submission identities and
   bind them to immutable intent. A retry after an ambiguous network result must
   return the original send result, not send again. JMAP creation IDs alone do
   not provide idempotency across separate requests. Acceptance and recipient
   delivery remain distinct states.
6. **Discovery and limits.** Specify Session fields, account capabilities, request
   and method limits, supported filters/sorts, result references, errors and binary
   endpoint behavior. Implement required Core behavior before claiming Core
   conformance. Advertise only the implemented RACR capability subset.
7. **Authentication.** Reuse current account sessions and scoped API credentials
   where their policy permits. OIDC testing is not a dependency. Do not silently
   expose passkey-only draft or approval operations to ordinary API credentials.
   Provider-specific reauthentication/approval integration remains explicit work.

Relevant implementation owners:
[mailbox operations](../apps/server/src/accounts/messaging.ts),
[inbox cursor](../apps/server/src/accounts/inbox-updates.ts),
[drafts](../apps/server/src/accounts/drafts.ts),
[Trash](../apps/server/src/accounts/message-trash.ts),
[publications](../apps/server/src/accounts/publications.ts), and
[client cache](../apps/client/src/lib/mailbox-cache.ts).

## Accepted product decision: preserve mailbox state on provider migration

Read/unread state and saved drafts must move with the account. These are
confirmed phase 5 requirements. Include Trash too unless a concrete implementation
complication justifies omission; no such complication has been established.

The transfer implementation must preserve:

- Read/unread markers for retained mailbox messages.
- Saved draft content, revision/conflict information, selected recipients,
  forwarding references and referenced attachment/image data needed to resume
  editing. Preserve references explicitly and report any unavailable dependency;
  never silently drop content or recipients. Importing a draft does not send it
  or grant recipient/connection authority.
- Enough mailbox disposition information to keep trashed, permanently deleted
  and expired copies from reappearing in active folders when protocol history is
  imported. This does not require making Trash contents restorable at the new
  provider.

Plan to carry Trash contents and the Trash setting. Before
implementing any necessary omission, specify how excluded items are represented and explain
the transfer behavior to the user. If Trash is carried, preserve its original
retention deadlines. Active saved drafts are mandatory; the treatment of drafts
already in Trash follows the explicitly documented Trash policy.

The current [history contract](../spec/account-history.md), portable v9/managed
v10, preserves received read/Trash state, saved drafts with required upload bytes,
and mailbox preferences. Return-trip tests cover edits, deletions and original
Trash timestamps without sending drafts. Sent dispositions and category-publication
batch controls remain outside the transfer domain and require further work.

The recommended synchronization rule remains a new provider/account state epoch
and a fresh client download after transfer. Resetting cursors and caches must not
reset the preserved read markers or saved drafts. Sessions, credentials and
provider replay state remain outside account-history transfer.

Update the relevant transfer versions, schemas, validation, export/import and
conformance tests in the same implementation change. Cover both managed and
portable account moves, cutover races, retries and return/cancellation behavior.
Prove that the destination preserves saved state and that old-source activity
cannot overwrite it after cutover. Full phase 5 completion requires this proof.

## Proposed implementation sequence and acceptance

1. **Specify the profile and expose read-only access.** Define the initial message
   object and ID mapping, authenticated Session discovery, bounded query/get and
   exact signed-byte access. Prove account isolation and rejection of unsupported
   methods/capabilities. Keep the current clients usable throughout.
2. **Make synchronization complete.** Add transactional change history and
   deletion records covering all writers. Prove two clients converge after new
   delivery, changes, deletion, missed polling, expired state and provider reset.
3. **Preserve mailbox state through transfer and add mutations.** Extend the
   transfer contract and prove the accepted portability requirements above.
   Reuse existing services for read/Trash state and drafts first,
   then relationship/Grant operations with their existing approval authority.
   Prove stale edits fail safely and login cannot bypass consent.
4. **Add submission and migrate clients.** Prove concurrent/ambiguous retries
   produce one logical send; preserve pending sends. Move GUI and CLI workflows
   as each workflow reaches parity, removing its obsolete API surface and
   compatibility-only machinery in the same change under the replacement policy above.

The first two steps can proceed while the agreed user-data transfer extension is
specified; their ID and state design must accommodate preservation from the start.
Full phase 5 completion still requires all checklist items, including reference
client adaptation. The received-message read slice and read/Trash/deletion web workflows are implemented; the broader synchronization
item remains open until the other object types and recovery paths are covered.
