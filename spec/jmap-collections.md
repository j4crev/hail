# Hail JMAP account collections v1

Status: implemented alpha extension under `https://haili.app/ns/jmap/account`.
The [account profile](jmap.md) defines discovery, framing and authentication.
These are Hail objects using RFC 8620 method conventions, not RFC 8621 Email,
Mailbox, EmailSubmission or Identity objects.

## Capability, authority and identity

The Session capability advertises `{version:1,types:["HailSent",
"HailSubmission","HailGrant","HailRelationship"]}`. The account capability's
`types` contains only collections readable by that session:

| Collection | Required read scope | Purpose |
| --- | --- | --- |
| HailSent | messages:read | Logical sent items and local Trash disposition |
| HailSubmission | messages:read | Durable sending intent and per-target progress |
| HailGrant | grants:read | Current signed Grant revision for a local role |
| HailRelationship | account:read | Connection, invitation and conversation metadata |

Every method takes the current Session `accountId`; another account ID produces
`accountNotFound`. Missing read scope produces `accountNotSupportedByMethod`.
Collection reads confer no consent, signing, token-recovery or mutation authority.
`HailSent/set` additionally requires an unfenced passkey session with both message
scopes. Other mutations use [typed account operations](jmap-operations.md), whose
existing domain authority, exact consent and durable retry checks still apply.

Each object has a provider-local opaque `id` string. IDs identify collection
records, not protocol UUIDs, DIDs or content hashes. States are opaque and scoped
to provider, account, serving generation and collection, independent of a query's
filter. Destroyed record identities are never reused within retained projections.
A provider transfer/new serving generation changes account IDs, states and record
IDs. Clients MUST fetch a fresh snapshot and discard old local synchronization
identifiers; portable domain history is preserved separately. Derived collection
objects, change logs and states are not migration payloads.

## Objects

All properties are server-managed except HailSent `isInTrash`. Server-managed
means clients cannot patch them through set; it does not mean the domain value
never changes. Numbers below are JSON numbers, UUIDs/DIDs and base64url values
are strings, Booleans are JSON booleans. Timestamps are UTC timestamp strings
unless a field explicitly uses Unix seconds. Nullable fields remain present as
null. Exact signed bytes, not decoded projections, remain the cryptographic
representation.

### HailSent

One object represents one direct message, category publication or connection
batch that has at least one submitted envelope and has not been permanently
removed from Sent. Multiple recipient envelopes remain one logical Sent item.
Two independently submitted identical bodies remain distinct items.

| Property | Type and meaning |
| --- | --- |
| id | Opaque collection record ID |
| sendId | Logical send UUID; direct message UUID or batch/publication UUID |
| kind | `message`, `category` or `connections` |
| category | Category string, or null for connection batches |
| createdAt | Original send timestamp |
| bodyDigest | Unpadded base64url SHA-256 digest of exact stored body bytes |
| bodyBlobId | Authenticated handle for exact stored body bytes |
| isInTrash | Boolean local Sent Trash membership |
| trashedAt | Original Trash timestamp or null |

Direct-message category metadata is currently null in this collection projection;
use the signed envelope or the sent-message view for its category. The body handle
requires a live Sent object in the current account/generation. Recipient deletion
does not remove the sender's Sent item; Sent deletion does not recall recipients'
copies or erase submission/envelope evidence.

### HailSubmission

One object represents each retained logical sending intent, including an intent
with no submitted targets yet. Sent disposition does not remove this object.

| Property | Type and meaning |
| --- | --- |
| id | Opaque collection record ID |
| sendId / kind / category / createdAt / bodyDigest | Same logical-send metadata as HailSent; direct-message category is null |
| targets | Array ordered by target message UUID; may be empty |

Each target has exactly these properties:

| Property | Type and meaning |
| --- | --- |
| messageId | Target envelope UUID |
| submitted | Boolean: a retained outgoing envelope exists |
| completed | Boolean: durable target/delivery state is terminal |
| submissionState | `pending`, `submitted`, `blocked`, `cancelled`, `expired` or `indeterminate`; direct envelopes use `submitted` |
| deliveryState | Current authenticated delivery-state string, or null |
| deliveryRevision | Current authenticated delivery revision number, or null |
| recipientDid | Recipient DID, or null if unavailable |
| envelope | Exact outgoing COSE bytes as unpadded base64url, or null before an envelope exists |

Submission and delivery are distinct: an outgoing envelope or an HTTP response
alone does not prove authenticated delivery. Consumers MUST preserve that
distinction. Collection reads do not submit/retry/cancel work. Use the typed
submission operations with retained intent IDs, draft revisions and exact retry
material; do not generate fresh IDs after an ambiguous outcome.

### HailGrant

| Property | Type and meaning |
| --- | --- |
| id | Opaque collection record ID |
| grantId | Grant lineage UUID |
| localRole | `grantor` or `grantee` |
| grantor / grantee | Protocol DIDs |
| revision | Current Grant revision number |
| status | Current signed status, `active` or `revoked` |
| digest | Unpadded base64url digest of exact current signed representation |
| cose | Exact current signed Grant bytes as unpadded base64url |

The current revision is visible to its local owner and a registered collocated
receiver. A receiver's read role does not become grantor authority. Revocation
updates the retained object rather than erasing signed history. Collection status
is signed state, not an independent expiry calculation or proof of permission to
send; normal domain validation still evaluates applicability and expiry.

### HailRelationship

This is a tagged union. Every variant has `id` and `kind`; only the properties for
that kind appear. These are safe account metadata, not portable authority proofs.

| kind | Additional properties |
| --- | --- |
| connection | `pairId` UUID, `connectionId` UUID, `peerDid` DID, `peerAddress` string, `state` (`active` or `disconnected`), `epoch` number, `updatedAt` timestamp, `unseen` Boolean |
| invitation | `invitationId` UUID, `personal` Boolean, `label` string, `expiresAt` Unix-seconds number or null, `revokedAt` timestamp or null |
| attempt | `attemptId` UUID, `pairId` UUID, `direction` (`outbound` or `admitted`), `state` (`pending`, `admitted`, `active`, `expired` or `conflict`), `expiresAt` timestamp |
| preferences | `allowIntroductions` Boolean, `updatedAt` timestamp |
| connectionPreferences | `connectionId` UUID, `epoch` number, `allowIntroductions` Boolean, `updatedAt` timestamp |
| membership | `creatorDid` DID, `conversationId` UUID, `state` (`active` or `left`), `expiresAt` timestamp or null, `leftAt` timestamp or null |

Empty connection pairs are not objects. A preference object exists only where a
preference row exists; absence does not invent an explicit setting. Retained
revoked invitations and expired attempts remain represented until a domain
mutation removes them. Wall-clock expiry alone does not advance collection state.
Invitation objects MUST NOT expose tokens, hashes, ciphertext, nonces, signed
invitations, signing evidence or bearer URLs. Attempt objects likewise exclude
consent bundles and signatures. Fetching metadata never accepts an invitation,
marks a connection seen, joins a conversation or creates consent.

## Common read and synchronization methods

For each collection name `T`, the following methods are defined. Unknown method
arguments yield `invalidArguments`; `queryChanges` yields
`cannotCalculateChanges`. Only HailSent supports `set`; other collection set
calls yield `unknownMethod`.

- `T/get {accountId,ids?,properties?}` returns
  `{accountId,state,list,notFound}`. Absent/null `ids` selects all live records,
  bounded to 50; more records yield `requestTooLarge`. Explicit IDs must be a
  string array of at most 50. Duplicates produce one returned object;
  missing/foreign/destroyed IDs appear once each in `notFound`. Absent/null `properties`
  returns all properties; a string array selects those properties plus `id`.
  Unknown requested properties reject the method with `invalidArguments`. Properties valid for another relationship variant are omitted when absent on a particular object. Results are ordered by record ID.
  An encoded list exceeding 8 MiB yields `requestTooLarge`; query IDs and fetch
  smaller pages when full signed representations exceed this budget.
- `T/query {accountId,filter?,sort?,position?,limit?,calculateTotal?,anchor?,anchorOffset?}`
  returns `{accountId,queryState,canCalculateChanges:false,position,ids}` and
  `total` only when requested. Filter defaults to `{}` and allows only `kind`,
  `isInTrash`, `peerDid`, `status`, `grantor`, `grantee`, `sendId`. Values must be
  strings or Booleans; matching is exact property equality and all entries are
  ANDed. A missing property or wrong scalar type matches nothing. Unknown keys
  yield `unsupportedFilter`. No nested/operator filters are defined. These keys
  apply where present in the selected object's schema; e.g. relationship
  `kind:"invitation"` selects invitation metadata and Sent `isInTrash:true`
  selects Trash. An empty filter includes both active and Trash Sent objects.

  Sort defaults to `[{property:"id",isAscending:true}]`; this is the only
  supported comparator array; object key order is irrelevant and omitted `isAscending` defaults to true. Other sorts yield `unsupportedSort`. `position`
  defaults to 0, negative positions count from the end and clamp at 0. `limit`
  is an integer 0–50, default 50. `calculateTotal` is Boolean, default false.
  A non-null `anchor` must name a live object in the filtered result, otherwise
  `anchorNotFound`; malformed anchor syntax yields `invalidArguments`.
  `anchorOffset` is an integer, default 0; negative resulting positions clamp to
  0. Anchor takes precedence over position.
- `T/changes {accountId,sinceState,maxChanges?}` returns
  `{accountId,oldState,newState,hasMoreChanges,created,updated,destroyed}`.
  `maxChanges` is an integer 1–50, default 50. The reference provider retains
  change events for at least 31 days. Cleanup commits a durable retention floor;
  expired, future, malformed, other-collection, other-account or old-generation
  states yield `cannotCalculateChanges`. Obtain a fresh snapshot after this
  error. IDs remain reserved after their event history expires.

Changes are serialized by account/generation/collection and describe committed
projection changes. Get/query reads pair data with the corresponding committed
state. Domain writes from typed operations, federation, background workers,
retention and migration/import refresh projections and change records in their
transaction. A rollback publishes neither. Identical projections and no-op
writes do not advance state; refreshing projections is not a GET side effect.

`maxChanges` bounds events scanned, not distinct output IDs. Within a page,
created+updated coalesces to created, created+destroyed is omitted, and an existing
object ultimately destroyed appears only in destroyed. Continue using newState
while hasMoreChanges is true, even for an empty page. Fetch created/updated IDs,
remove destroyed/notFound IDs and rerun query for ordering. A later get may see a
newer object than the change page; processing subsequent pages still converges.
A collection state is shared by independent filtered readers; it is not a
filter-specific cursor. No notification is necessary for correctness.

## HailSent/set

Arguments are `{accountId,ifInState?,ifTrashEnabled?,create?,update?,destroy?}`.
`ifInState` is a string or null; non-null must equal current HailSent state.
`ifTrashEnabled`, when supplied, is a Boolean equal to the current account Trash
preference. A mismatch rejects the entire call with `stateMismatch` before any
change. Absent/null maps and arrays are empty. At most 50 create/update/destroy
entries are accepted. Only an unfenced passkey session with `messages:read` and
`messages:write` may call this method.

Updates are maps from opaque record IDs to patches containing only Boolean
`isInTrash`. Other properties, missing Boolean values or unsupported patches
return per-item `invalidProperties` with `properties:["isInTrash"]`. Missing,
foreign or destroyed IDs return `notFound`. Every create returns `forbidden`:
Sent objects arise from durable submissions, not caller-authored collection data.

`isInTrash:true` requires Trash enabled and all logical-send members completed;
otherwise return `forbidden`. It creates a server timestamp. Repeating an already
satisfied disposition is a no-op and does not extend retention.
`isInTrash:false` restores an existing disposition only if its original timestamp
is newer than 30 days ago; otherwise `notFound`. Restore itself does not require
Trash enabled, but a caller's explicit `ifTrashEnabled` guard still applies.
Destroy requires all members completed and either existing Trash membership or
Trash disabled. It permanently removes only the Sent projection via retained
local disposition. No signed envelope, submission intent or recipient copy is
erased. The incomplete-member check uses durable authenticated delivery/target
state, not a client assertion.

If an ID occurs in update and destroy, update returns `willDestroy` for an existing
object and only destroy is evaluated; a missing ID reports destroy `notFound`.
Valid entries can succeed alongside invalid ones. Successful updates map IDs to
null; clients get changed objects to retrieve server timestamps. The response is
`{accountId,oldState,newState,created,updated,destroyed,notCreated,notUpdated,notDestroyed}`,
with empty maps/arrays null and created always null. Account locking, state and
preference checks, accepted disposition changes and projection refresh share one
transaction. Unexpected failure rolls back everything; no-ops preserve state.

Expired Trash remains a represented object until a durable domain deletion
produces a destroyed change. Its presence does not promise restorability.

## Synchronization versus application views

Collections are durable synchronization surfaces. `HailMailbox/view` supplies
bounded application projections such as decoded inbox bodies, logical Sent detail
and conversation grouping; those view pagination cursors are not collection
states. Neither view reads nor collection reads mark items read, retrieve remote
body content or mutate consent. Use collections for reconciliation and typed
operations for actions whose authority or exact intent is richer than a patch.
The reference clients use the same domain services as before the transport
replacement; there is no legacy HTTP adapter or old-route fallback.

Full `/get` projections conform to [the account object schema](schemas/jmap-account-object-v1.json); [projection vectors](vectors/jmap-account.json) do not replace signed COSE conformance vectors.
