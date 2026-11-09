# Shared conversation control objects

Status: Draft implementation. Both codecs, provider admission and durable grants,
version 4 delivery, the Reply all client, leave/expiry, and authenticated
portable conversation checkpoints are implemented. A signed descriptor alone
never authorizes delivery. Existing envelope versions retain their meaning.

## Fixed roster descriptor

`hail.conversation` version 1 is an immutable proposal signed by the original
creator's `#hail-messaging` key. It uses deterministic Hail CBOR, tagged COSE_Sign1
and content type `application/hail-conversation+cbor`. Maximum signed size is
16384 bytes. The closed payload contains:

- `type`: `hail.conversation`.
- `version`: integer 1.
- `conversation_id`: fresh random UUIDv7, scoped to the creator DID.
- `from`: original creator DID and expected signer.
- `membership_revision`: integer 1. This profile supports a fixed roster only.
- `participants`: 3–101 distinct canonical DIDs, including `from`, sorted in
  ascending ASCII order. The limit allows a creator plus 100 recipients.
- `created_at`: nonnegative integer UTC Unix seconds.
- `admission_until`: UTC Unix seconds, strictly after `created_at` and at most
  604800 seconds (7 days) later.

The descriptor's version fixes the membership policy: adding anyone requires a
new conversation, and admission does not authorize disclosure of prior history.
Recipients control their own inactivity leases; the creator cannot prescribe or
extend those leases through this descriptor.

`admission_until` bounds initial introduction processing and replay retention. It
does **not** expire an admitted recipient's conversation grant. That grant has its
own local lease, with a provider policy of 90 days from admission or a new
Reply all batch. Codec validation is clock-independent so archived descriptors
remain decodable after their initial admission window.

The descriptor is bound to each initial delivery through envelope version 4. Before admission, a recipient provider must verify that binding,
the creator's signature and current authority, a qualifying active creator-to-
recipient connection, recipient membership and current introduction preferences.
The product default is enabled for an unset preference; explicit global and
per-connection opt-outs override it. A provider must not infer authority merely
from a valid descriptor signature, membership or knowledge of the conversation ID.

The immutable descriptor identity is `(from, conversation_id)`. Reusing that pair
with different signed bytes is a conflict, not an update. Retrying the exact
descriptor must not extend leases, recreate deleted grants, or override a leave.

## Envelope version 4 and delivery

Each recipient still gets a separately signed envelope, unique delivery ID and
body token. `authorization` has type `conversation`, creator DID, conversation
ID, membership revision 1 and the SHA-256 hash of the complete signed descriptor.
`conversation_message_id` identifies one logical message across its recipient
copies. The root logical ID equals the conversation ID. Reply parents refer to
logical IDs; they never confer delivery authority.

An initial envelope additionally carries `conversation_introduction`, containing
the signed descriptor and the exact creator-to-recipient connection ID and epoch.
Only the creator may send this form; it cannot carry a reply parent. Admission
verifies current creator authority, descriptor signature/hash/roster, recipient
service authority, exact live connection (including coordinator freshness), and
recipient introduction preferences under the account/connection write barriers.
Absent preferences default on. A repeated introduction never renews a lease or
undoes a leave. The creator stores its own permission when proposing the group.

Reply all uses the fixed roster. Both the sender provider and recipient provider
require their local active membership. The receiver rechecks permission before
body retrieval and atomically before final delivery. It verifies every sender's
current messaging signature independently. No B–C connection is created by an
A–B–C conversation. Disconnecting A does not itself revoke a conversation grant;
**Leave conversation** does. A global sender-blocking feature is not implemented;
when added, its denial must take precedence over all conversation permissions.

Authenticated existing delivery-status responses acknowledge admission/delivery.
A generic HTTP 202 is not acceptance. Shared outboxes retry the same immutable
signed envelope for up to the existing 24-hour batch deadline, including when a
reply arrives before another recipient's introduction. Verified asynchronous
status receipts also settle pending outboxes. Unconfirmed delivery remains
indeterminate at the deadline; there is no downgrade to private copies.

## Recipient lease and controls

The reference provider grants each participant 90 days (7,776,000 seconds)
from admission. Creating a new Reply all batch while participation is active
renews only the sender's lease to 90 days from that action. An exact batch retry
does not renew it again. Replies do not extend other participants' deadlines.
Opening or reading messages, incoming delivery, background work, bulk mark-read,
and archiving MUST NOT renew participation. There is no group-wide activity timer.

Leave immediately revokes incoming and outgoing shared authority. Explicit Rejoin
applies only to manually left participation whose existing deadline has not
passed, and preserves that deadline. Leaving and rejoining MUST NOT circumvent
expiry. Expired participation cannot be renewed by any participant, including
the creator; continuing requires a new conversation under current introduction
policy. There is no revival object, endpoint, or creator privilege.

Leaving and expiry MUST NOT trash or delete messages or remove them from the
Inbox. Saved history remains readable until the owner chooses to remove it.
Message delivery deadlines and descriptor admission deadlines do not expire
already delivered history. User-directed deletion and Trash retention are
separate mailbox policies.

## Storage and account portability

The reference provider stores preferences, immutable deduplicated descriptors,
compact memberships, v4 envelope metadata and immutable message outboxes.
Maintenance may remove left/expired permission only after the descriptor's
admission window plus clock tolerance and when no saved envelopes or outboxes
reference it. Unreferenced descriptors can then be deleted. Cleanup never
deletes saved mailbox messages merely because participation ended.

Migration 0107 removes the obsolete revival tables and cutover triggers, including
pending requests. It changes the membership default to 90 days and caps existing
deadlines at the earlier of their current expiry or 90 days after the last
recorded activity (admission if absent). Historical activity included opens; that
recorded instant is used only as the upgrade anchor. New reads never extend it.
No messages, bodies, or descriptors are deleted by this upgrade. Back up before
upgrading: discarded revival records require restoring that backup to roll back.
Historical migrations remain immutable for deployed database checksums.

Portable snapshots version 7 and managed snapshots version 8 include a separately
versioned `hail.conversation-history` checkpoint and digest. It carries explicit
default/connection overrides, descriptors and historical signing evidence,
active/expired/left membership and terminal shared-message outboxes. Connection
history uses its separate v3 checkpoint domain. Pending sends retain the existing
drain rule. The current alpha checkpoint excludes obsolete revival records; old
checkpoints containing those tables are rejected and must be re-exported.
Imports validate exact ownership, signed descriptor linkage, roster and intent
hashes, current canonical PLC history and historical signing keys before activation.
Imports preserve expiry timestamps rather than issuing fresh leases. On return,
current source preferences and membership replace stale mutable destination
state; absent source membership cannot restore an old active grant. Same-provider
custody checkpoints also include conversation state and require drained work.

## Current profile and verification

Apply migrations before deploying the server/client. Providers and transfer CLIs
must understand envelope v4 and snapshot v7/v8 respectively. Earlier snapshot versions are outside the current alpha contract. Unsupported peers cannot accept shared delivery; recipients remain
unconfirmed and the sender sees bounded per-recipient results. Never silently
broaden connection/subscription permissions or reinterpret historical private
copies as shared messages. Migration 0107 requires backup restoration for rollback; earlier rollback scripts
refuse once corresponding conversation data exists.

Reply all also accepts an account’s own sent shared message as its source.
Private replies still require a direct connection. Shared and private threads
remain separate, and Reply all is offered only on shared source messages; private
history is never automatically quoted into the group.

`packages/hail-codec-ts/vectors/conversations-v1.json` contains immutable fixtures
for TypeScript and Go, including descriptors and v4 envelopes. Test keys
are public fixtures and must never be used by an account. Database tests exercise
same-provider and separate-provider test scenarios, policy denial, introduction
races, leave/expiry, portable consent and rollback guards. These exercise
the reference implementation, not an independently developed provider. Operational
release evidence is tracked separately in
[production readiness](../agents/production-readiness.md).
