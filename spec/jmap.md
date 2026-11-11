# Hail JMAP account profile v1

Status: implemented alpha account synchronization and workflows using the
[RFC 8620](https://www.rfc-editor.org/rfc/rfc8620.html) Session, method envelope,
result references, binary transfer and object-method conventions. This is a Hail
extension, not RFC 8621 Email/Mailbox interoperability. Push/events remain phase 6;
the advertised Core capability does not claim complete Core push support.

The profile includes received messages below, [drafts](jmap-drafts.md),
[Sent, submission, Grant and relationship collections](jmap-collections.md), and
[typed account operations](jmap-operations.md). Web and CLI account workflows use
these methods. Superseded mailbox, submission, Grant and relationship HTTP routes
and the delivery-sequence cursor are removed without an old-client fallback.
Provider login, credential administration, owner/recovery authorization,
federation and distinct attachment/media resources remain separate protocols.
See the [replacement policy](../agents/standards-phase-5.md#replacement-policy-remove-superseded-account-api-machinery).

## Discovery, authentication and limits

Authenticated `GET /.well-known/jmap` returns the Session. The provider reuses its
existing account sessions and scoped bearer credentials; login remains
provider-controlled. The caller must possess `messages:read` for received-message methods
and received/Sent downloads. Uploads require `messages:write`; uploaded blobs
can be read with either message scope. Other collections and operations have
their own explicitly documented scopes. Login never confers owner/recovery authority. Cookies on POST require
an exact configured browser Origin. A supplied foreign Origin is rejected for all
methods. Clients MUST bind credentials to the selected provider and MUST NOT
forward credentials on redirects or provider migration.

Session capabilities are `urn:ietf:params:jmap:core` and
`https://haili.app/ns/jmap/messages` with `{version:1,mutableProperties:["isRead","isInTrash"],canDestroy:true}`. The latter
is present in accountCapabilities and primaryAccounts only with `messages:read`.
There is one authenticated account, with `isPersonal:true`. Its `isReadOnly` is
false only for an unfenced session with both `messages:read` and
`messages:write`. Its received-message account capability has `mutableProperties:["isRead","isInTrash"],canDestroy:true`
for a passkey session. Scoped bearer sessions expose `mutableProperties:[],canDestroy:true`
and retain CLI permanent deletion only. Other sessions expose
`mutableProperties:[],canDestroy:false`. Bearer credentials do not gain browser
read-state or Trash mutation authority.
The account extension `https://haili.app/ns/jmap/account` advertises
`{version:1,types:["HailSent","HailSubmission","HailGrant","HailRelationship"]}`
at Session level. Its account capability lists only types readable with the
caller's scopes; the account is its primary account. This capability also enables
typed account operations, whose write/consent checks remain method-specific.
Draft capability and authority are defined in [the draft profile](jmap-drafts.md).

`username` and account `name` are the canonical address. The Session state changes
when its visible properties change. Core limits are:

| Property | Value |
| --- | --- |
| maxSizeRequest | 8388608 bytes (8 MiB) |
| maxCallsInRequest | 16 |
| maxObjectsInGet | 50 |
| maxConcurrentRequests | 4 per account |
| maxSizeUpload | 26214400 bytes (25 MiB) |
| maxObjectsInSet | 50 |
| maxConcurrentUpload | 2 per account |
| collationAlgorithms | [] |

The reference provider additionally allows 32 concurrent requests globally and
120 requests per minute per source address. A request body has a 10-second read
budget; binary uploads have a 60-second read budget. Responses are private
(`Cache-Control: no-store`). Uploaded bytes have a 100 MiB account quota and a
24-hour lifetime. These are reference-provider storage policies. The events URL
returns 501 `unsupportedCapability`; clients poll changes until phase 6 push is
implemented and MUST NOT rely on notifications for correctness.

POST the Session `apiUrl` (`/jmap`) as UTF-8 application/json with no content
encoding or URL query. Reject duplicate JSON keys. The request has `using`,
`methodCalls`, and optional `createdIds`; unknown outer request properties are ignored. Each
call is `[name,arguments,callId]`. Core must be in `using`; unknown capabilities
fail the request with `unknownCapability`. Hail methods additionally require the
Hail capability in `using`. Calls execute sequentially and independently, not as
an implicit transaction. A failure yields `["error",{type},callId]`; later calls
still execute. Typed operation errors may additionally carry `httpStatus`,
`description` and a stable domain `code`; internal failures expose only `serverFail`. Responses have `methodResponses` and `sessionState`. Optional `createdIds` seeds
creation-ID resolution; its keys and ID values must each match
`[A-Za-z0-9_-]{1,255}`. Successful `created` entries from earlier set calls add
their IDs. When the request supplied `createdIds`, the response includes the
resulting map. A `#creationId` is resolved in typed `ids`, `destroy`, `blobIds` and update-map
keys; unresolved IDs continue to normal method validation. Arbitrary strings,
including user content, are never recursively rewritten.

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
this reset MUST NOT erase portable user data.
No JMAP IDs, states, upload handles or change logs are included in account-history exports. Portable history preserves supported mailbox read/Trash state, drafts and Sent disposition independently of these local projections.

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

  Unfenced access and both message scopes are required for the method. Updates
  and creates additionally require a passkey session. A bearer session may send
  destroy-only batches, preserving CLI permanent deletion even for an active
  message when Trash is enabled. Browser destroy retains the Trash precondition;
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
the browser credential. Binary upload/download use distinct resource handling; they are not arbitrary JSON proxy targets.
Known JMAP read-only POST batches do not invalidate mailbox caches; writes and
unrecognized batches do, including ambiguous outcomes and per-item failures.

The former mailbox, Grant, submission and relationship routes are replaced by
these methods and [typed operations](jmap-operations.md). No fallback is supported;
upgrade provider and clients together. CLI `inbox delete` and `message delete`
discover the account, query sender/message identity and destroy with
`ifInState=queryState`. An absent copy is already deleted; a state mismatch
requires a fresh explicit retry. Conversation actions, Sent/draft Trash,
preferences and Empty Trash retain their domain authorization under the new
methods. A transport change grants no new signing or consent authority.

Trash expiry does not silently alter the JMAP collection based on wall-clock
filters. Expired Trash remains represented until durable deletion, then produces
a destroyed change. Such rows are not a promise of restorability. UI clients must
apply the provider's retention policy; reads do not extend deadlines.

## Synchronization, retention and recovery

Delivery, read-state changes, Trash/restore and deletion record their changes in
the same transaction as the mailbox change, including changes from domain
services, workers, retention and import. No-op writes do not advance state. Failed
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

## Binary upload, download and copy

POST raw bytes to the Session `uploadUrl`, with the authenticated account ID and
Content-Type (default `application/octet-stream`). An unfenced `messages:write`
session is required. Content-Encoding is rejected. Success returns
`{accountId,blobId,type,size}` with exact byte length; bytes are stored unchanged.
The 25 MiB limit, 100 MiB account quota, two concurrent uploads and 24-hour expiry
apply independently of JSON method limits. Quota exhaustion returns 413
`overQuota`. Upload does not create a message, draft attachment, or signature.
`HailAttachment/import` explicitly turns eligible uploaded bytes into the
existing attachment domain representation, with its own content validation.

Expand the Session `downloadUrl` with `accountId,blobId,name,type`. GET requires
current account/generation access and a live received/Sent copy or unexpired
upload. Received/Sent handles require `messages:read`; upload handles allow
`messages:read` or `messages:write`. Foreign, destroyed, expired and unknown
handles return 404. Name is at most 255 characters. Optional type must be a valid
printable MIME type at most 255 characters; otherwise use the stored MIME type.
Downloads preserve exact bytes and use attachment disposition, UTF-8 filename,
nosniff, sandbox CSP and no-store. Requested type/name changes no signature or
digest domain.

`Blob/copy` takes exactly `{fromAccountId,accountId,blobIds}`. Both accounts must
be the authenticated current account; foreign source/destination errors are
`fromAccountNotFound`/`accountNotFound`. At most 50 string blob IDs, each at most
255 characters, are accepted. Duplicate IDs are coalesced. Accessible upload or
received-message blob handles map to themselves in `copied`; missing handles
map to `{type:"notFound"}` in `notCopied`. Empty maps are null. Same-account copy
does not extend upload retention or create a second byte allocation. Sent body handles also support same-account copy. Cross-account sharing is not implemented.

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

Collection synchronization, typed submission retries, reference client adoption,
and portable read/Trash/draft/Sent history are part of this phase 5 profile.
Push notifications and streaming remain phase 6; no generic email-client or
complete Core push interoperability is claimed. See the
[phase 5 implementation plan](../agents/standards-phase-5.md) and the collection,
draft and operation documents for their distinct wire formats and authority.
