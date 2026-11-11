# Hail JMAP drafts v1

Status: implemented alpha read/write/synchronization subset of the optional
[JMAP client profile](jmap.md), using RFC 8620 get/query/changes semantics.
Draft creation, editing and Trash mutations are available through HailDraft/set.
The web editor and draft lists/actions use this capability; send consumption remains atomic
with publication acceptance.
Portable v11 and managed v12 [account history](account-history.md) preserve drafts,
required attachment uploads and original Trash timestamps.
This is not RFC 8621 Email draft compatibility.

## Capability and authority

`https://racrproto.com/ns/jmap/drafts` has Session capability
`{version:1,mutableProperties:['content','isInTrash'],canCreate:true,canDestroy:true,maxGetBytes:2097152}`. It appears in the account's
accountCapabilities with `readOnly` reflecting message mutation authority and in primaryAccounts only when the
caller has `messages:read` and a current passkey session. Ordinary scoped API
credentials MUST NOT gain access to editable draft content by selecting JMAP.
Discovery, request framing, result references, Origin checks, account-generation
admission, no-store responses and rate/concurrency limits are shared with the
message profile. Calls must opt in to Core and the draft capability in `using`.
Unsupported methods return `unknownMethod`; a foreign account returns
`accountNotFound`; missing draft authority returns `accountNotSupportedByMethod`.

## Object and identity

The [projection schema](schemas/jmap-draft-v1.json) defines:

| Property | Meaning |
| --- | --- |
| id | Opaque account/generation-local draft incarnation ID |
| draftId | Original UUID used by the existing editor and publication service |
| revision | Existing positive draft revision for edit/send conflict checks |
| content | Exact stored editable JSON under the [draft content contract](provider-drafts.md) |
| updatedAt | Stored UTC edit timestamp |
| isInTrash | Whether the draft has a Trash timestamp |
| trashedAt | Original UTC Trash timestamp or null |

Only content and isInTrash are mutable. Reading does not save a
revision, restore a draft, send a message or grant recipient authority. Content
preserves selected recipients, forwarding references, unfinished text, builder
fields and attachment metadata exactly as stored. Embedded bytes remain embedded;
external attachment/upload references remain references. Returning a reference is
not proof that its external content is available, nor a transfer of those bytes.
Existing owner-bound upload/download validation remains authoritative.

The JMAP id is distinct from draftId: deleting and recreating the same editor ID
MUST allocate a new incarnation ID. Destroyed IDs are never reused. Provider or
serving-generation changes reset the account ID, record IDs and sync state; they
do not authorize loss of required portable draft content. Draft and message state
tokens are separate and cannot be substituted. JMAP identity/log tables are derived
provider-local state and are not account-history export collections.

## Methods and limits

Each method requires the Session accountId and rejects unknown arguments.

- `HailDraft/get`: optional `ids` (null means all, maximum 50) and `properties`
  (null means all). Always return id; duplicate requested IDs produce one object.
  Unknown IDs go in notFound; unknown properties fail with invalidArguments.
  Returns `{accountId,state,list,notFound}`. A complete get response is capped at
  2,097,152 UTF-8 bytes, independent of the 50-object limit. The provider checks
  stored projected content size before loading it into application memory and
  verifies final response size. Exceeding either limit returns requestTooLarge;
  clients may request metadata only, then fetch content in smaller ID batches.
  The advertised byte limit is per get response, not per HTTP method batch.
- `HailDraft/query`: optional filter has only `inTrash` (Boolean) and `draftId`
  (UUID). No filter includes active and durable Trash rows. Sort supports exactly
  one updatedAt comparator with optional isAscending (default true); omitted/null
  sort defaults to descending. Equal timestamps sort by immutable JMAP id
  ascending. position defaults to zero; negatives count from the end. anchor and
  anchorOffset locate an item in the filtered collection; missing anchors return
  anchorNotFound. Negative resulting positions clamp to zero. limit is 0–50,
  default 50; calculateTotal defaults false. Returns `{accountId,queryState,
  canCalculateChanges:false,position,ids,limit}` and optionally total.
- `HailDraft/changes`: required sinceState and optional maxChanges (1–50,
  default 50). Returns `{accountId,oldState,newState,hasMoreChanges,created,
  updated,destroyed}` with the message profile's chronological pagination,
  coalescing, 31-day change retention, durable retention floor and
  cannotCalculateChanges recovery semantics.
- `HailDraft/queryChanges`: cannotCalculateChanges; rerun query.

## Every writer participates

Save, overwrite, Trash, restore, permanent deletion, Empty Trash, disabling Trash,
retention expiry and successful send consumption update the draft journal in the
same transaction as the draft row. A failed save/send transaction leaves both the
draft and state unchanged. A byte-for-byte no-op SQL update produces no event;
a successful editor save that increments revision is an update even if its content
is unchanged. Immutable draft identity fields cannot be rewritten in place.

Expired Trash remains represented until durable cleanup, so visibility cannot
change without a corresponding event. Such rows MUST NOT be treated as
restorable; the existing 30-day restore deadline remains in force. Deletion events
remain available after the content is gone. Clients process every page (including
empty coalesced pages), fetch created/updated IDs, remove destroyed/notFound IDs,
and rerun query for ordering. After an expired token, download a fresh snapshot.

## Implementation and verification

Migration 0113 backfills current drafts and initializes generation-local states.
Account reservation cleanup removes derived empty state without blocking transfer
activation. Rollback refuses once JMAP draft identities exist because reapplying
would otherwise reuse the same epoch with different record IDs. It never drops
editable draft storage.

The [request vectors](vectors/jmap-drafts.json) cover capability routing and
result references. The [draft integration tests](../apps/server/test/jmap-drafts.integration.test.ts)
cover preexisting-draft backfill, identity immutability, exact stored references,
isolation, anchors, concurrent commit ordering, change pagination, send rollback and
consumption, identity non-reuse, expiry, preference cleanup, scoped discovery,
capability opt-in and bounded reads. The existing draft service remains the owner
of edit revisions and attachment retention. Client workflows must move before removing the previous APIs; this capability
alone does not complete phase 5 portability.

## Conditional draft writes

`HailDraft/set` accepts accountId, optional ifInState, optional Boolean ifTrashEnabled and create/update/destroy,
with at most 50 total objects. It requires a passkey session, messages:read and
messages:write, and an unfenced active account. The provider locks the account and
draft state for the entire operation; a stale ifInState fails with stateMismatch
before any writes. A supplied ifTrashEnabled must match current preferences or
the entire call fails with stateMismatch. Clients MUST supply the state they edited to detect concurrent
changes. A null/omitted condition is an explicitly unconditional write.

Create entries contain draftId (an unused UUIDv7 editor/publication identifier)
and content. Existing drafts or accepted Sent IDs cannot be overwritten by create.
Update entries accept whole content and/or isInTrash; nested content patches are
not supported. Content must satisfy the existing editable-content contract and
the 400,000-byte storage limit. Invalid objects produce per-object
invalidProperties errors without applying their patches. Content cannot change
while remaining in Trash. Restore and content replacement may be atomic.

Trash requires enabled Trash preferences, preserves the first Trash timestamp,
and can be restored only within 30 days. Destroy requires an already trashed
object or disabled Trash. Expired restore returns notFound. Missing IDs return
notFound; an ID in update and destroy is considered only for destruction and
returns willDestroy for its update. Successful changes increment revision and
updatedAt; identical content/Trash patches do not advance state. Responses follow
Core SetResponse, including computed revision, updatedAt and trashedAt fields.
Create allocates a fresh opaque ID; no operation sends the draft.
