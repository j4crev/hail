# Reference-provider mailbox cleanup

This is reference-provider application policy and its authenticated account API,
not a federation operation or a new envelope format. Deleting a mailbox copy
never recalls a recipient's copy, revokes reply authority, cancels delivery, or
changes signed protocol evidence.

## Unread totals

`GET /api/v1/account/unread-counts` requires the authenticated account's
`messages:read` scope and accepts no query parameters. It returns JSON
`{ "subscriptions": 0, "connections": 0, "unseenConnections": 0 }`, with nonnegative integer counts
independent of pagination. For `subscriptions` and `connections`, count only received,
unread, non-trashed delivered messages belonging to that account. Connection-
and shared-conversation-authorized messages contribute to `connections`; other
authorization types contribute to `subscriptions`. Count messages, not threads;
sent messages never contribute. Reading, marking unread, trashing, restoring,
and deleting affect subsequent totals. Invalid queries return `400`, unsupported
methods `405`, and missing scope `403`, using normal account authentication rules.

The client displays positive totals beside Feed (`subscriptions`) and Inbox
(`connections`), right-aligned, and hides zero or unavailable totals. This display
is client behavior, not a federation requirement.

## Unseen connections (reference-provider account API)

`unseenConnections` counts active, non-tombstoned incoming connections with an
unacknowledged marker in the account's current serving generation. It is separate
from unread messages. The same authenticated `unread-counts` response carries it;
no separate count endpoint is required. Existing `messages:read` authorization
applies to this navigation summary.

The provider creates a marker atomically when a live admitted connection becomes
active, keyed by account, connection ID and epoch. Outbound attempts and crossed
consent with an outstanding outbound attempt do not create a marker. Pending,
failed and expired attempts do not count. Replaying or reconciling an already
applied activation cannot recreate a marker. Disconnecting hides its marker from
totals immediately; reconnecting through a fresh admission can create a new one.

`GET /api/v1/account/connections` includes boolean `isNew` and positive integer
`epoch` on each connection. The bounded list (at most 100) puts unseen connections
first, then orders each group by latest connection state update descending, with
pair ID as a stable tie-breaker. Reading the list does not acknowledge anything.
Counts cover all active unseen connections, including entries outside that list.

`POST /api/v1/account/connections/seen` takes exactly:

```json
{"connections":[{"id":"01900000-0000-7000-8000-000000000001","epoch":1}]}
```

Require a current passkey session, matching Origin, JSON content type, no query
parameters, an active unfenced account, and 1–100 distinct IDs. Each item has
exactly `id` (UUID) and `epoch` (positive safe integer). Return `{"ok":true}`.
Acknowledge only matching account, current generation, ID and epoch markers.
Repeated, unknown and obsolete references are harmless no-ops; they never affect
another account, a newer epoch, or connections omitted from the request. Invalid
input returns `400`, unsupported methods `405`; ordinary connection API
session/origin, fencing, content-type and rate-limit errors apply. This cosmetic
write requires no new passkey assertion or signed connection consent.

`connection_unseen` is provider-local presentation state, not authorization or
federated history. It is deliberately excluded from both account transfer
formats. Existing connections at rollout, and reconstructed connections after an
account move, start acknowledged. Changing a peer's provider or address does not
create a marker. Generation binding prevents stale markers reviving if an account
returns. Losing this presentation state cannot change connection permissions.

Client behavior: show a naked positive number beside Connections and a dot on the
mobile navigation button; hide zero/unavailable counts. Group unseen entries above
older entries with a teal divider, distinct from selected-row styling. After a
successful render in the visible page (outside an open connection dialog),
acknowledge the displayed IDs/epochs and refresh the count. Retain that visit's
new grouping until navigation away. Failed acknowledgment remains retryable;
background tabs and failed list loads do not clear it. Refresh while visible
approximately every 30 seconds and on focus. No system notifications or subscriber
activity are introduced.

## Received-message mutations

The web client uses `HailMessage/set` with read/Trash patches or destruction,
`ifInState`, and a Trash-setting precondition for delete/restore; see
[the JMAP profile](jmap.md). The old per-message mark-read/mark-unread provider
routes, per-message delete and received-message bulk restore are removed. Existing passkey, scope and migration-fence policy still
applies. Reads alone never mark a message read. Trash timestamps remain server-set, retries
never extend retention, and expired copies cannot be restored. The CLI permanent-delete
endpoint and whole-account Empty Trash remain separate existing workflows.

## Folder actions

The passkey-authenticated account API requires `messages:write`, the existing
same-origin/CSRF checks, an active unfenced account and no in-progress migration
for every mutation below. Requests use `Content-Type: application/json`, no
content encoding, and exactly the members shown. Mutations serialize on the
owning account and never affect another account's mail.

| POST path under `/api/v1/account` | Body | Result |
| --- | --- | --- |
| `/trash/empty` | `{}` | `{deleted: number}`; permanently removes all received copies and saved drafts in Trash, and makes all sent Trash copies non-restorable |
| `/sent/clear` | `{trashEnabled: boolean, messages?: [{kind: "category" \| "connections" \| "message", messageId: UUIDv7}]}` | `{affected: number, state: "trashed" \| "deleted"}`; clears eligible selected Sent items, or all eligible Sent items across every page when `messages` is omitted |
| `/sent/restore` | `{kind: "category" \| "connections" \| "message", messageId: UUIDv7}` | `{restored: number}`; restores one live sent Trash item to Sent |

`trashEnabled` is the setting the user saw, not permission to override it. A
mismatch with the transaction's current account preference returns `409` without
changing mail. Invalid bodies return `400`; ordinary authentication, scope,
method, media-type and migration errors follow the other mailbox mutations.
Emptying or clearing an already-cleared folder succeeds with a zero count.

When supplied, `messages` must contain 1–100 objects with exactly `kind` and
`messageId`; invalid identities or extra members return `400`. Duplicate identities
count once. Unknown, other-account, already removed and active sends are skipped;
only newly removed items contribute to `affected`. An empty or null selection is
invalid and must never fall back to clearing the folder. The same preference check,
transaction and eligibility rules apply to selected and whole-folder cleanup.

A send is a sealed category publication, a sealed connection/shared-conversation
batch, or a standalone envelope, using the existing `(kind, messageId)` Sent
identity. It must have at least one submitted envelope to appear in Sent. It is
eligible for cleanup only when **every** target has a known terminal result:
submitted envelopes have `delivered`, `failed`, or `cancelled` delivery status;
non-submitted publication targets may be `blocked`, `cancelled`, or `expired`.
Pending targets, accepted/on-hold deliveries, absent delivery status and
indeterminate submissions keep the entire send active. A completed target in an
active batch cannot be cleared separately. Cleanup does not change worker state.

With Trash enabled, Sent copies become restorable for 30 days from the original
removal time. Retrying cleanup cannot extend that deadline. Restore after expiry
or permanent deletion returns zero. Disabling Trash immediately makes existing
received, sent and draft Trash non-restorable; future Sent cleanup deletes the mailbox
copy permanently. Sent copies removed from the mailbox also disappear from its
normal conversation views. Restoring a batch restores its constituent copies.

`GET /sent?include=sends&trash=true` lists live sent Trash using the existing Sent
pagination cursor. `GET /sent/:id?kind=K&trash=true` reads one live sent Trash
item; expired or permanently deleted copies return `404`. Duplicate/unknown
query parameters and `trash` values other than `true` are rejected. The normal
Sent list and message readers omit removed copies. Protocol delivery-status and
submission-retry APIs remain separate from mailbox visibility.

## Storage, transfer and rollout

`account_sent_dispositions` stores local mailbox disposition by account, send
kind and send ID. A row hides the send from normal views; its timestamp bounds
restore, and `deleted` prevents restore immediately. Permanent mailbox deletion
does **not** erase retained immutable publication bodies, signed envelopes,
delivery history or reply evidence. Those records serve distinct protocol
continuity purposes; this action is not a secure-erasure or storage-reclamation
API. Received mailbox copies use the existing received-body reference cleanup.

Like the existing UI-only preferences, these local dispositions are outside the
current [account-history profile](account-history.md). Provider migration is not
a promise to preserve folder cleanup state. A portable mailbox-disposition
representation remains an unresolved interoperability decision; no new history
format or schema is implied by this provider-local table.

Apply database migration 0100 before deploying readers or actions that use it.
It creates presentation state and read views without rewriting signed records.
Old application versions do not honor new dispositions, so enable the new UI
only with the matching provider release. Rollback refuses while disposition
rows exist, rather than resurrecting deleted mail; reconcile/export that state
explicitly before rolling back the schema. Application rollback alone does not
undo database state.

## Client behavior

Desktop folder headers offer an ellipsis menu. Mobile uses the same dimensions,
placement and theme colors as the compose button. Trash uses **Empty Trash**
and a trashcan with an X. Sent uses **Move all to Trash** and a down-arrow
trashcan when Trash is enabled, otherwise **Delete all** and the X icon.
Confirmation states the whole-folder scope, permanence or 30-day restore period,
and that active sends stay in Sent. It uses **Cancel** and **Confirm**. Empty
folders disable the action. Successful cleanup refreshes the folder without a
success banner; failures remain visible and retryable.

[Saved drafts](provider-drafts.md) also participate in Trash. Emptying Trash,
disabling Trash and expiration remove draft content permanently; restoration
returns them to Drafts. Migration 0101 adds this provider-local compose storage.

## Planned mailbox-state portability

Phase 5 requires provider migration to preserve read/unread markers and saved
drafts. Trash portability is planned unless a concrete implementation complication requires omission. The [accepted portability requirements](../agents/standards-phase-5.md#accepted-product-decision-preserve-mailbox-state-on-provider-migration)
require protection against resurrecting trashed/deleted copies in active folders.
If Trash is transferred, preserve original retention times; otherwise specify
its omission explicitly without implying authorization to delete source data. This extends the current transfer contract; it is not yet implemented.
A fresh client synchronization after a move must reconstruct preserved user state.
