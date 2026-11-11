# JMAP account operations

Status: current alpha application methods under the capability
`https://racrproto.com/ns/jmap/account`. These methods complement the synchronized
`HailMessage`, `HailDraft`, `HailSent`, `HailGrant`, `HailRelationship` and
`HailSubmission` collections. They are Hail extensions to the JMAP Core method
framework, not JMAP Mail methods or a generic HTTP tunnel.

Every call includes the authenticated `accountId`. The JMAP router verifies that
account and capability before dispatch. Each response includes `accountId` and
the operation result described below. Unlisted arguments are rejected. Optional
pagination/selection strings accept null as absence. Pagination tokens are opaque,
view-specific provider cursors; they are not collection change states. No caller
may supply a provider URL, HTTP method, path or credential as an operation argument.
The services run under the authenticated serving generation.

All application operations below require the account capability in `using`,
alongside `urn:ietf:params:jmap:core`. Exact existing owner signatures, approval
records, passkey challenges, scope restrictions and migration fences remain
mandatory. A JMAP invocation does not itself create consent.

## Mailbox presentation views

`HailMailbox/view` takes `view` plus exactly the selection arguments for that
view. Every view requires `messages:read`. These are bounded presentation views
for reference clients; use the corresponding collection `/get` and `/changes`
methods for synchronization. Reads do not mark messages read.

| `view` | Selection arguments | Result |
| --- | --- | --- |
| `inbox` | `after?` | Delivered-message inventory and `next` |
| `inboxFeed` | `after?`, `channel?` (`all`, `subscriptions`, `connections`; default `all`), `trash?` (default false) | Received presentation messages with decoded body, relationship/reply context and `next` |
| `read` | `sender`, `messageId` | One received presentation message; missing/unauthorized copy is `notFound` |
| `sent` | `after?` | Per-envelope Sent inventory and `next` |
| `sentFeed` | `after?` | Per-envelope Sent presentation records and `next` |
| `sentSends` | `after?`, `trash?` | Logical Sent groups, preserving one item per publication/batch; `next` |
| `sentSend` | `kind` (`category`, `connections`, `message`), `messageId`, `trash?` | One logical Sent item; connection group detail includes original recipients |
| `sentMessage` | `messageId` | One retained per-envelope Sent message |
| `threads` | `sender`, `messageId` | Existing private-thread projection rooted at that message |
| `connectionInbox` | `after?` | Connection conversation summaries and `next` |
| `connectionThread` | `sender`, `messageId`, `offset?` | Connection/shared-thread presentation and continuation |
| `unreadCounts` | none | Received folder unread counts |
| `conversations` | `peer?`, `after?`, `trash?` | Peer inventory when peer absent; peer messages when present; `trash` is only valid for the inventory |
| `settings` | none | Trash/display preferences |
| `connectionAddress` | `peer` | Authenticated account's retained address for that connection peer |

`inboxFeed` with `trash:true` and `settings` additionally require a browser
session, preserving their existing policy. Bodies and decoded projections remain
untrusted content. They do not replace exact signed bytes exposed by the object
and blob APIs. View reads do not initiate new envelope submission.

`HailMailbox/conversationAction` takes `peer` and `action` (`mark-read`,
`mark-unread`, `trash`, `restore`). It requires `messages:write` and an unfenced
account. It retains the existing aggregate conversation authority for bearer and
browser clients, including original Trash timestamps and the account's Trash
setting. Returns `{peer,action,affected}`. It never alters signed history.

The following operations require an unfenced browser session and
`messages:write`:

| Method | Arguments | Result and invariants |
| --- | --- | --- |
| `HailMailbox/clearSent` | `input:{trashEnabled:Boolean,messages?:[{kind,messageId}]}` | `{affected,state}`; selection 1–100 when supplied; only terminal eligible logical sends; settings precondition checked atomically |
| `HailMailbox/restoreSent` | `input:{kind,messageId}` | `{restored}`; original 30-day retention deadline applies |
| `HailMailbox/emptyTrash` | none | `{deleted}` across received copies, Sent dispositions and saved drafts; protocol history is retained |
| `HailMailbox/preferences` | `input:{trashEnabled:Boolean}` OR a supported display-preference patch | Saved preference projection; disabling Trash atomically purges its contents |

Preference/Sent mutation input is at most 32768 UTF-8 JSON bytes. Individual
read-state and Trash edits use collection `/set` with state preconditions.

## Attachment import

`HailAttachment/import` takes `{filename,blobId}` and requires `messages:write`
and an unfenced account. First upload exact bytes through the JMAP Core upload
URL, then import its account/generation-bound blob ID. Import verifies the file
against the existing filename/type/content rules, account allowance and 25 MiB
limit, and stores the normal attachment-upload ownership record. It returns the
attachment diagnostic `{filename,media_type,size,digest}` with `accountId`.
A foreign, expired or stale-generation blob is `notFound`. The Core upload's
claimed MIME type does not bypass file validation. Referencing received bytes
additionally requires read authority through the blob service. This operation
replaces JSON/base64 upload requests; existing authenticated attachment download
and media-ticket resource endpoints remain distinct binary/presentation APIs.

## Submission

`HailSubmission/submit` takes `{kind,input}`. `kind` is `message`, `category`,
`connections` or `replyAll`. `input` is the existing closed domain intent:

- `message`: `messageId`, exactly one of `text`/`body`, and the exact Grant,
  connection or reply authorization/reference required by the selected send.
- `category`: `publicationId`, `category`, exactly one body, `allowReplies`, and
  optional `draftRevision`.
- `connections`: `publicationId`, exact selected connection IDs, one body,
  optional `delivery` selection and `draftRevision`.
- `replyAll`: `publicationId`, conversation identity, exact parent sender/message
  reference, and one body.

Input is at most 8 MiB of UTF-8 JSON. Every submit requires `messages:write` and
an unfenced current account. The original domain services validate all fields,
authority, content limits, draft revision/consumption and recipient membership.
The caller supplies and retains the durable message/publication ID before the
first attempt. The server does not generate replacement IDs on retry. A changed
intent under an existing ID fails; retrying an accepted intent returns its
existing result. Submission acceptance and recipient delivery are distinct.

| Method | Arguments | Scope / behavior |
| --- | --- | --- |
| `HailSubmission/status` | `kind` (`message`, `category`, `connections`), `id` | `messages:read`; original message status or batch target counts/delivery results |
| `HailSubmission/retry` | `id` | Unfenced `messages:write`; authenticated retained message must exist; resubmit its exact original bytes |
| `HailSubmission/cancel` | `kind` (`category`, `connections`), `id` | Unfenced `messages:write`; original cancellation policy preserves already-created ambiguous submission attempts |
| `HailSubmission/recent` | `kind` (`category`, `connections`) | `messages:read`; bounded recent publication inventory |
| `HailSubmission/audiences` | none | `grants:read`; category subscriber counts and recipient limit |
| `HailSubmission/targets` | none | Browser session plus `messages:read`; current selectable connection audience |

The durable domain response fields are preserved, with `accountId` added.
Changing transports does not change the publication ID, recipient snapshot,
per-recipient envelope ID, signed bytes or retry binding.

## Grants and exact owner approvals

| Method | Arguments | Authorization / result |
| --- | --- | --- |
| `HailGrant/list` | `after?`, `sender?` | `grants:read`; owned/received Grant summaries and `next` |
| `HailGrant/read` | `grantId` | `grants:read`; `{type:"racr.grant",version:1,localRole,digest,cose}` for this account only |
| `HailGrant/propose` | `input:{sender,category? OR scope,expiresAt}` | Unfenced `grants:write`; exact diagnostic Grant proposal for local owner signing |
| `HailGrant/submit` | `grantId`, `cose` | Unfenced `grants:write`; exact owner-signed COSE bytes, canonical unpadded base64url; owned revision lineage only |
| `HailGrant/managedCreate` | Same `input` as propose | Unfenced `grants:write`, managed custody; domain consent/signing policy applies |
| `HailGrant/proposeUpdate` | `grantId`, `input:{scope,expiresAt,expectedRevision,expectedDigest,refreshConsent,sender?}` | Unfenced `grants:write`, owned grantor lineage; exact revision/digest preconditions; returns diagnostic proposal |
| `HailGrant/managedUpdate` | `grantId`, `input:{payload,signingKey}` | Unfenced `grants:write`, managed custody and owned grantor lineage; exact active reviewed payload/current signing key; returns receipt plus original `cose` |
| `HailGrant/managedRevoke` | `grantId` | Unfenced `grants:write`, managed custody and owned grantor lineage |
| `HailGrant/reviewApproval` | `input:{sender,senderDid?}` | Current browser managed session; verified sender/profile review |
| `HailGrant/prepareApproval` | `input` containing the exact reviewed allow/restrict/revoke intent | Current browser managed session; account/session/generation-bound retained approval and passkey options |
| `HailGrant/commitApproval` | `input:{requestId,response?}` | Current browser managed session; exact stored intent and required passkey assertion; repeat returns original retained result |
| `HailGrant/approvalStatus` | `requestId` | Same session-bound authority; existing approval/result, never a renewed approval |

Proposal/create/update input is at most 16384 bytes. Update proposals bind the
previous revision/digest and preserve the explicit consent-refresh choice; a
changed permission is not silently re-proposed. Managed updates sign only the
reviewed active payload for this account and Grant, using the expected key. Signed Grant bytes are at most
262144 bytes; no decode/re-encode occurs before verification. Approval input is
at most 65536 bytes. These browser approval methods retain the established
managed-browser policy rather than requiring an ordinary `grants:write` bearer
scope; such a bearer cannot invoke them. Approval expiry, credential revocation,
changed sender identity/profile, stale revision and wrong generation remain
terminal or conflict conditions exactly as in the domain services.

Grant writes return `{grantId,revision,status,digest,publication:"durable"}`.
`digest` covers the original signed representation. Existing `racr.*` receipt
names are provider-client receipt identifiers, not alternate federation formats.

## Relationships

| Method | Arguments | Authority |
| --- | --- | --- |
| `HailRelationship/list` | none | Current browser session; local invitation codes and relationship inventory |
| `HailRelationship/review` | `input:{id,did,token}` | Current browser session; inspect exact invitation without granting connection authority |
| `HailRelationship/prepare` | `input` containing exact create/connect/disconnect/revoke intent | Browser session or owner-controlled API credential as permitted by the domain; creates retained approval |
| `HailRelationship/commit` | `input:{requestId,response?,cose?}` | Browser passkey approval and optional required external owner signature; API credential must supply exact external signature and no browser response |
| `HailRelationship/status` | `requestId` | Original session/generation-bound approval status |
| `HailRelationship/seen` | `input:{connections:[{id,epoch}]}` | Browser session; acknowledges only specified current connection notifications |
| `HailRelationship/credentialList` | none | API credential with `account:read`; relationship metadata, no invitation secrets |
| `HailRelationship/credentialInvitations` | none | API credential with `account:read`; invitation metadata, no tokens |
| `HailRelationship/credentialRemove` | `connectionId` | Unfenced API credential with `account:write`; authenticated disconnect policy |
| `HailRelationship/credentialRevokeInvitation` | `connectionId` | Unfenced API credential with `account:write`; revoke own invitation only |
| `HailRelationship/conversationPreferences` | optional `input` patch | Domain enforces `account:read` for inspection, `account:write` for mutation for API credentials, current account/session and fence policy |
| `HailRelationship/conversationMembership` | `input` with conversation identity and inspect/leave/rejoin action | Original signed-conversation membership policy and required message scope |

Browser input is bounded to 65536 bytes; API credential prepare/commit input to
32768; conversation preference/membership input to 4096. External connection
consent is canonical base64url carrying at most 16384 exact signed bytes. Managed
identity consent remains browser-only; introducing JMAP does not let an ordinary
API token sign as a managed account. Each method returns the existing domain
projection, including original approval request IDs, options, results and retry
state. Relationship collection visibility never includes invitation bearer tokens
or private signing material.

## Errors and retry

Malformed selections and closed-field violations return `invalidArguments`;
missing/foreign records return `notFound`; absent required scopes/session
capabilities return `forbidden`; stale revisions, conflicting intent or migration
fences return `stateMismatch`; oversized input returns `requestTooLarge`.
Domain errors may additionally carry `httpStatus`, safe `description`, and a
known `code` such as `MISSING_SCOPE`, `PASSKEY_REQUIRED` or `APPROVAL_EXPIRED`.
These are method error properties, not a change to the HTTP status of a successful
JMAP request. Internal exceptions become `serverFail`; never expose database or
signing internals. Unknown method names return `unknownMethod`.

An ambiguous failure is not evidence that a write failed. Retain the original
intent, durable submission/approval ID and exact signed bytes; inspect/retry that
same operation. No helper silently expands scopes, renews approval or replaces
an ambiguous operation with a fresh ID.
