# Hail JMAP received-message profile v1

Status: implemented alpha **received-message reads, read/Trash state and deletion**, not complete JMAP Core conformance
or completion of phase 5. [RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html)
defines the Session, request/response envelope, result references and method
semantics used here. This extension does not implement RFC 8621 Email/Mailbox.
Sent items, other mutations, relationship/Grant operations, submission, Blob/copy,
upload and events are not yet implemented. Existing client APIs remain available;
the web client now uses JMAP for individual read/unread, received-message
Trash/restore and deletion, and draft reads and writes. Other web and CLI
workflows have not switched. Federation is unchanged.

This coexistence is temporary implementation staging, not a compatibility promise.
As each reference-client workflow moves to JMAP, remove its superseded account API
surface and old cursor/compatibility machinery in the same change. No support for
obsolete client versions is required during this pre-launch transition. Current
authentication, owner-approval and federation surfaces remain unless explicitly
replaced. See the [replacement policy](../agents/standards-phase-5.md#replacement-policy-remove-superseded-account-api-machinery).

[Draft reads, writes and synchronization](jmap-drafts.md) are available as a separate
capability with the existing passkey-only draft access policy.

## Discovery, authentication and limits

Authenticated `GET /.well-known/jmap` returns the Session. The provider reuses its
existing account sessions and scoped bearer credentials; login remains
provider-controlled. The caller must possess `messages:read` for message methods
or downloads. Login never confers owner/recovery authority. Cookies on POST require
an exact configured browser Origin. A supplied foreign Origin is rejected for all
methods. Clients MUST bind credentials to the selected provider and MUST NOT
forward credentials on redirects or provider migration.

Session capabilities are `urn:ietf:params:jmap:core` and
`https://haili.app/ns/jmap/messages` with `{version:1,mutableProperties:["isRead","isInTrash"],canDestroy:true}`. The latter
is present in accountCapabilities and primaryAccounts only with `messages:read`.
There is one authenticated account, with `isPersonal:true`. Its `isReadOnly` is
false only for an unfenced passkey session with both `messages:read` and
`messages:write`. Its Hail account capability has `mutableProperties:["isRead","isInTrash"],canDestroy:true`
for that session, otherwise `mutableProperties:[],canDestroy:false`. Ordinary bearer credentials
do not gain browser mailbox mutation authority.
`username` and account `name` are the canonical address. The Session state changes
when its visible properties change. Core limits are:

| Property | Value |
| --- | --- |
| maxSizeRequest | 1048576 bytes |
| maxCallsInRequest | 16 |
| maxObjectsInGet | 50 |
| maxConcurrentRequests | 4 per account |
| maxSizeUpload | 0 (upload unavailable) |
| maxObjectsInSet | 50 |
| maxConcurrentUpload | 1 |
| collationAlgorithms | [] |

The reference provider additionally allows 32 concurrent requests globally and
120 requests per minute per source address. A request body has a 10-second read
budget. Responses are private (`Cache-Control: no-store`). Upload returns 403;
events return 501. Their Session URL templates reserve the required discovery
fields, not a claim that those operations work. Full Core behavior is a remaining
phase 5 requirement; consumers must not infer full conformance from the Core
capability identifier in this staged profile.

POST the Session `apiUrl` (`/jmap`) as UTF-8 application/json with no content
encoding or URL query. Reject duplicate JSON keys. The request has `using`,
`methodCalls`, and optional `createdIds`; unknown properties are rejected. Each
call is `[name,arguments,callId]`. Core must be in `using`; unknown capabilities
fail the request with `unknownCapability`. Hail methods additionally require the
Hail capability in `using`. Calls execute sequentially and independently, not as
an implicit transaction. A failure yields `["error",{type},callId]`; later calls
still execute. Responses have `methodResponses` and `sessionState`; supplying
`createdIds` produces an empty response map because no creation method exists.

`Core/echo` returns its resolved arguments. Result references use `#argument` with
exactly `{resultOf,name,path}`, referencing an earlier call's result. JSON Pointer
`~0`/`~1` escaping and array `*` expansion apply. Invalid/missing results or an
argument supplied both directly and by reference yield `invalidResultReference`.
Paths are at most 1024 characters and 32 segments. Unknown methods yield
`unknownMethod`; a foreign account ID yields `accountNotFound`; absent read scope
yields `accountNotSupportedByMethod`. Unknown method arguments yield
`invalidArguments`. HTTP framing errors use application/problem+json and RFC 8620
error URNs; expired/absent credentials return 401.

## Identity and message object

IDs and states are opaque. Account IDs bind provider origin, local account and
serving generation. Record IDs identify one **received mailbox copy**, not a
protocol message or a Sent batch. A permanently removed copy's ID MUST NOT be
reused, even if the same sender/message identity is subsequently imported again.
Provider transfer or a new serving generation changes the account ID and requires
a fresh download. Clients MUST discard old synchronization tokens and record IDs;
this reset MUST NOT erase portable user data once that transfer extension exists.
No JMAP IDs, states or change logs are included in current account-history exports.

The [message schema](schemas/jmap-message-v1.json) defines the object:

| Property | Meaning |
| --- | --- |
| id | Opaque provider-local record ID |
| sender / recipient | Protocol DIDs |
| messageId | Original protocol message UUID |
| deliveredAt | UTC mailbox delivery timestamp |
| isRead | Local read marker |
| isInTrash | Local Trash membership; mutable independently of the signed content |
| trashedAt | Original UTC Trash timestamp, or null |
| envelope | Unpadded base64url of exact stored signed COSE bytes |
| envelopeBlobId / bodyBlobId | Opaque authenticated download handles |

Decoded projections do not replace signed objects. Reads MUST NOT mark messages
read or trigger sender-side body retrieval. Downloads return locally verified
stored body bytes or the original envelope bytes. Metadata, read state and Trash
are local mailbox facts, not new signed fields.

## Methods

All Hail methods require `accountId` equal to the Session account.

- `HailMessage/get`: `ids` defaults to null (all objects, or `requestTooLarge`
  if more than 50); an explicit list is limited to 50. Duplicate IDs produce one
  object; missing IDs are reported in `notFound`. `properties` defaults to null
  (all properties); a supplied list always includes `id` in the result. Unknown
  properties fail. Returns `{accountId,state,list,notFound}`.
- `HailMessage/query`: optional `filter` has only `isRead` (Boolean), `inTrash`
  (Boolean), `sender` (did:plc), `messageId` (protocol UUID). Sender and messageId
  together resolve a received copy from its protocol identity. No filter includes
  both active and durable Trash
  rows. `sort` supports exactly one `deliveredAt` comparator with optional
  `isAscending` (default true); omitted/null sort defaults to descending.
  Equal timestamps sort by immutable record ID ascending. Unknown filters/sorts
  return `unsupportedFilter`/`unsupportedSort`. `position` defaults to zero;
  negatives count from the end. `anchor` and `anchorOffset` (default zero) locate
  an object in the filtered result; an absent anchor returns `anchorNotFound`.
  Negative resulting positions clamp to zero. `limit` is 0–50, default 50;
  `calculateTotal` defaults to false. Returns `{accountId,queryState,
  canCalculateChanges:false,position,ids,limit}` and optionally `total`.
- `HailMessage/changes`: required `sinceState`, optional `maxChanges` integer
  1–50 (default 50). Returns `{accountId,oldState,newState,hasMoreChanges,created,
  updated,destroyed}`. See synchronization below.
- `HailMessage/queryChanges`: always `cannotCalculateChanges`; rerun query.
- `HailMessage/set`: optional `ifInState`, `ifTrashEnabled`, `create`, `update`,
  `destroy`, with at most 50 total entries. Absent/null maps and arrays are empty.
  A non-null `ifInState` MUST equal current message state; an optional Boolean
  `ifTrashEnabled` MUST equal the current account Trash setting. Either mismatch
  fails the entire call with `stateMismatch` before any change. The preference
  guard is distinct because a preference change need not change message state.
  Updates are PatchObjects keyed by opaque record ID. Only Boolean `isRead` and
  `isInTrash` may change. Identical server-set properties are accepted; changing
  immutable/unknown properties or supplying a non-Boolean mutable value returns
  per-item `invalidProperties` with `properties`, applying none of that patch.
  Missing/foreign/destroyed IDs return `notFound`.

  `isInTrash:true` requires Trash enabled and sets the original server timestamp.
  Repeating it is a no-op and MUST NOT extend retention. If Trash is disabled,
  reject it with `forbidden`; never silently convert this patch into deletion.
  `isInTrash:false` restores a retained copy only while Trash is enabled and its
  original timestamp is newer than 30 days ago. An expired/unavailable restore
  returns `notFound`, leaving the entire patch unapplied. Already-active copies
  remain active. A read marker may be updated together with successful restore,
  but a patch that leaves the item in Trash and supplies isRead is `forbidden`.

  `destroy` permanently removes the received mailbox copy when it is in Trash
  (including expired Trash) or when Trash is disabled. Destroying an active copy
  while Trash is enabled returns `forbidden`; use isInTrash instead. Unknown IDs
  return `notFound`. Only the removed copy's body provenance is cleaned up, and
  only when no remaining mailbox copy references it. Immutable received-envelope
  history is retained. No deletion grants sender, relationship or owner authority.
  If an ID occurs in both update and destroy, update returns `willDestroy` (or
  `notFound` for an absent ID) and only the destroy operation is evaluated.
  Creates remain `forbidden`: this method is not message submission.

  Unfenced passkey access and both message scopes are required for the method;
  unauthorized calls fail with `forbidden` (or `accountNotSupportedByMethod` when
  read scope is absent). The response has `{accountId,oldState,newState,created,
  updated,destroyed,notCreated,notUpdated,notDestroyed}`. Empty collections are
  null. Successful updates map IDs to server-computed `{trashedAt}` when that
  timestamp changes, otherwise null. Valid entries still succeed if another
  entry is invalid. No-ops preserve state. Account locking, both preconditions,
  all accepted changes, cleanup and change-log entries share one transaction;
  unexpected transaction failure rolls everything back.

The web client resolves a message using sender/messageId and supplies queryState
as ifInState for each mutation. It also sends the Trash setting the user confirmed
when deleting: true requests isInTrash, false requests destroy. Restore requires
ifTrashEnabled true. A changed setting or concurrent edit is reported without an
automatic retry against newer state. A concurrent delivery or another item's
mutation can also change this account-wide state.

The browser uses fixed same-origin JSON bridge paths `/api/jmap/session` and
`/api/jmap`, bound to the configured provider; Session-supplied URLs never receive
the browser credential. Binary endpoints are not exposed by this JSON bridge.
Known JMAP read-only POST batches do not invalidate mailbox caches; writes and
unrecognized batches do, including ambiguous outcomes and per-item failures.

The former per-message `mark-read`, `mark-unread` and `delete` endpoints under
`/api/v1/account/inbox/:sender/:messageId/`, and `/api/v1/account/trash/restore`,
are removed with their web callers. No fallback is supported. Upgrade provider
and web client together. The CLI permanent-delete endpoint remains until its
bearer-authorized workflow moves to JMAP. Aggregate conversation operations,
Sent/draft Trash, settings and whole-account Empty Trash are also distinct
workflows still using their existing endpoints.

Trash expiry does not silently alter the JMAP collection based on wall-clock
filters. Expired Trash remains represented until durable deletion, then produces
a destroyed change. Such rows are not a promise of restorability. UI clients must
apply the provider's retention policy; reads do not extend deadlines.

## Synchronization, retention and recovery

Delivery, read-state changes, Trash/restore and deletion record their changes in
the same transaction as the mailbox change, including changes from existing HTTP
routes, workers, retention and import. No-op writes do not advance state. Failed
transactions publish neither data nor state. State allocation serializes per
account/generation before commit: sequence allocation alone is insufficient.
Get/query snapshots pair committed data with its corresponding state.

The reference provider keeps changes for at least 31 days. Bounded cleanup leaves
a durable retention floor; older, future, malformed, cross-account or old-epoch
tokens return `cannotCalculateChanges`. Clients then obtain a fresh snapshot.
Destroyed record identities remain reserved even after change history expires.

Changes are paginated in chronological commit order. A page may have fewer than
maxChanges IDs because events for one ID are coalesced: created then updated is
created; created then destroyed within one page is omitted; existing then deleted
is destroyed. No ID appears in multiple arrays in one response. Each intermediate
newState marks exactly that page boundary. Continue with newState while
hasMoreChanges is true, even if arrays are empty. Fetch created/updated objects
with get and remove destroyed/notFound IDs. Later writes may make a fetched
object newer than a page; subsequent pages still converge. Rerun query to obtain
current ordering and filters. Clients must not depend on notifications.

## Binary download

Expand the Session downloadUrl with `accountId,blobId,name,type`. GET requires the
same account scope and generation and a live received copy. Foreign, destroyed or
unknown handles return 404. Name is at most 255 characters. The optional type
is a printable MIME type at most 255 characters; absent type uses
`application/hail-body+cbor` or `application/cose; cose-type="cose-sign1"`.
Downloads are attachments with UTF-8 filename, nosniff, sandbox CSP and no-store.
No signature/digest domain or bytes change with the requested download type/name.

## Verification and remaining work

[Executable request vectors](vectors/jmap.json) cover method-envelope behavior.
[Database/HTTP conformance tests](../apps/server/test/jmap.integration.test.ts)
exercise exact-byte access, isolation, result references, filters/anchors,
paginated two-client convergence, read/Trash/restore/delete, transaction rollback,
commit ordering, expired state, identity non-reuse, read-state preconditions,
concurrent writes, per-item failures and capability/scope/Origin checks. Client
unit tests cover discovery, protocol-identity lookup, conditional mutation,
conflict handling and the configured-provider JSON bridge.
Synthetic database fixture bytes test carriage, not new cryptographic validation;
existing envelope/body ingestion remains responsible for signature verification.

Phase 5 still requires the remaining object types, other mutations and their preconditions,
submission idempotency, complete Core support, reference client adoption and
managed/portable migration of read state, saved drafts and planned Trash state.
See [phase 5 implementation plan](../agents/standards-phase-5.md).
