# JMAP notifications

Status: implemented alpha phase 6 notification profile. This profile follows
[RFC 8620 §7](https://www.rfc-editor.org/rfc/rfc8620.html#section-7), with
[RFC 8030](https://www.rfc-editor.org/rfc/rfc8030.html) delivery,
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html) encryption and
[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292.html) VAPID.

## Wire contract

The Session advertises `https://racrproto.com/ns/jmap/events` with
`{transport:"eventsource",types:[...]}` listing implemented collection types.
The extension may appear in a JMAP request's `using` list but defines no methods.
The `eventSourceUrl` template is
`/jmap/events?types={types}&closeafter={closeafter}&ping={ping}` at the provider origin.
Clients MUST use the same authenticated authority as their JMAP Session.

`GET` accepts exactly these query parameters, each once:

- `types`: `*` or unique comma-separated implemented Hail type names.
- `closeafter`: `state` closes after one state event; `no` keeps the stream open.
- `ping`: unsigned decimal seconds. Zero disables pings. The reference provider
  clamps nonzero intervals to 30–300 seconds and rejects values above six digits.

Malformed queries return HTTP 400. Unknown types are rejected; a known type without
read authority is omitted. An empty authorized selection or fenced account is
refused with 403. Missing/revoked authentication returns 401. Other methods return
405. Cookie and Origin checks match the JMAP transport's authentication policy.

Responses use `text/event-stream`, `Cache-Control: no-store` and no proxy buffering.
A `state` event contains a JSON StateChange object:

```text
event: state
data: {"@type":"StateChange","changed":{"account_example":{"HailMessage":"account_example_m_12"}}}
id: <opaque-state-fingerprint>

```

[Schema](schemas/jmap-state-change-v1.json) and [vectors](vectors/jmap-events.json)
define the current StateChange shape.

Only opaque account IDs, authorized type names and their current `/get` state
tokens are sent. No message IDs, bodies, sender identities, subjects, drafts,
invitation secrets or credentials are included. The current implementation sends
the full selected type-state map when any selected state changes; clients MUST
tolerate repeated unchanged type states. Notifications do not mark messages read,
send drafts, acknowledge transport delivery or constitute signed delivery evidence.

The event ID is a base64url SHA-256 fingerprint of that selected state map and
account ID. `Last-Event-ID`, when supplied, MUST be a 43-character base64url ID.
Matching IDs suppress the initial duplicate; missing or different IDs cause an
immediate current-state event. No notification replay archive is required.
`ping` events contain `{"interval":30}` (the actual negotiated interval), carry
no event ID, and are sent after the interval since the previous event.

## Authorization, lifecycle and recovery

State reads observe committed collection revisions. Each read revalidates the
credential, account, scopes and serving generation. Revocation, expiry, migration
fences, generation changes, read failures or changed authorization terminate the
stream; reconnecting requires fresh authorization. Passive stream checks MUST NOT
extend session idle time. A change racing a check may precede termination; no
post-revocation data lookup is authorized by an old stream session alone.

Reference-provider policy: at most two streams per account and 64 per process,
separate from the ordinary four-request account limit; excess returns 429. Streams
have a five-minute lifetime, read states every two seconds while waiting, and use
backpressure rather than accumulating unbounded event queues. Disconnects and
cancellation release stream slots. No persistent database connection or lock is
held across waits. Multiple provider processes observe the shared database states.
These limits are reference implementation policy, not portable wire requirements.

Clients MUST recover through `/changes` or a fresh snapshot, never advance their
local synchronization cursor solely from a notification. Duplicates, reordered
hints, missed events, reconnect and provider restart must converge identically to
polling alone. Account/generation changes discard local cursors as in the base
[JMAP profile](jmap.md). The reference web client coalesces hints, uses bounded
reconnect backoff, pauses streams while hidden/signed out, and retains periodic
and focus-triggered polling. It opens only the configured same-origin
`/api/jmap/events` bridge; Session-supplied URLs never receive browser credentials.
The bridge permits SSE only for that exact endpoint and propagates cancellation.

## Background subscriptions

When configured, the Session advertises `https://racrproto.com/ns/jmap/push` with
`{applicationServerKey:"<base64url P-256 point>",contentEncoding:"aes128gcm",maxSubscriptions:4}`.
This extension declares the encryption/VAPID profile; `PushSubscription/get` and
`PushSubscription/set` use the RFC 8620 core capability. Without configuration,
these methods are unavailable and the push capability MUST be absent.

Subscriptions belong to the creating credential (including the specific browser
session), not merely its account. These methods have **no `accountId` or state**:
get accepts `ids` and `properties`, returning `list` and `notFound`; set accepts
`create`, `update`, `destroy`, returning the corresponding success/failure maps.
Neither `ifInState` nor `oldState`/`newState` applies. Creation/result references
follow the ordinary JMAP request rules. Unknown arguments are rejected.

Create accepts `deviceClientId`, `url`, `keys:{p256dh,auth}`, `types`, `expires`
and absent/null `verificationCode`. `deviceClientId` is a client-generated opaque
identifier, unique per credential. `p256dh` is a canonical base64url uncompressed
65-byte P-256 public point and `auth` a canonical 16-byte base64url secret. The
endpoint and keys are immutable and MUST NOT be returned by get (explicitly
requesting them returns `forbidden`). Get returns `id`, `deviceClientId`,
`verificationCode`, `expires`, `types`, and the read-only Hail extension
`verificationError`; the code remains null until verification. The error is null,
`pushServiceRejected` for a non-success push-service response, or `deliveryFailed`
for a failed delivery operation. An error does not establish whether an uncertain
network request reached the browser; a valid delayed acknowledgment still clears it.
Clients without this extension may omit it through `properties`.
Create returns the assigned id and actual expiry. Types are unique authorized
collection names; null/omitted means all currently authorized implemented types,
and an empty array means no state hints. Expiry is a future RFC 8620 UTCDate or
null for a provider default. Updates accept only `verificationCode`, `expires`
and `types`. Destroy and update cannot access another credential's subscriptions.

The provider sends one encrypted `PushVerification` immediately after creation:
`{"@type":"PushVerification","pushSubscriptionId":"<id>","verificationCode":"<random-code>"}`.
The code is a random 32-byte canonical base64url secret. The receiving client
updates that subscription's `verificationCode` using the same authenticated
credential. Wrong codes fail with `invalidProperties`. Until verified, the
provider MUST make no further requests to the endpoint, including retrying the
verification request after an uncertain delivery. The client can destroy and
recreate a failed registration. Successful verification captures baseline states;
subsequent committed changes produce encrypted StateChange objects with the same
shape as connected events. Delivery can be duplicated, delayed, reordered or
lost; clients MUST recover via JMAP synchronization. A successful HTTP push
response is neither user receipt nor Hail delivery evidence.

[Push schema](schemas/jmap-push-v1.json) and [vectors](vectors/jmap-push.json)
define creation, returned subscription and verification objects. Keys, endpoint
URLs and verification secrets MUST NOT appear in logs, notification text, account
history exports or migration snapshots. Subscriptions and registration quotas are
provider/device-local state, never migrated or automatically recreated on a new
provider. Renewed authentication requires new subscriptions.

Before each delivery, the provider MUST revalidate the stored credential reference,
account activity, scopes, serving generation and any upstream identity. Passive
checks MUST NOT extend session idle lifetimes. Invalid/expired/revoked credentials,
changed scopes, migration fences and obsolete generations invalidate subscriptions.
An already dispatched request cannot be recalled. Transient authorization failures
must fail closed; they do not authorize sending. Subscription expiry cannot grant
authentication beyond the credential's own expiry/idle timeout.

Reference-provider policy (not RFC requirements):

- Seven-day maximum/default expiry; unverified subscriptions expire after 15 minutes.
  At most four subscriptions per credential, ten per account, and ten successful
  registrations per account per hour. Per-request set/get limits are 50 objects.
- Endpoints must use HTTPS on port 443, canonical DNS names, no userinfo or fragments.
  Resolve exclusively public addresses and pin DNS results for every request;
  never follow redirects or send browser/API credentials. Encrypt using `aes128gcm`
  with VAPID audience bound to the endpoint origin. HTTP payloads are at most 4096
  bytes, TTL at most 300 seconds and no longer than remaining subscription lifetime.
- Workers claim database leases, process at most eight rows per five-second tick,
  and inspect unchanged/pending subscriptions no more than once per 30 seconds.
  Lease expiry recovers process crashes. Expired-row cleanup is bounded per tick.
  No message bodies are queried; state maps coalesce changes between inspections.
- For verified subscriptions, 404/410 and other permanent non-success responses
  remove the destination. 429/5xx and network failures retry at 30 seconds doubling
  to one hour; Retry-After can lengthen that delay up to one hour. Six consecutive
  failures remove the subscription. Successful sends reset the failure count.

## Reference browser behavior and operational verification

Settings provides an explicit opt-in action; page load never prompts for permission.
A service worker receives encrypted push through the browser's Push API. Verification
uses the fixed same-origin `/api/jmap` bridge. State hints check the current account
through `/api/jmap/session` before showing generic “Your mailbox has updates.” text.
Both background requests use `X-Hail-Background: true`, which only disables idle-time
refresh and grants no additional authority. No message content or payload-provided
navigation URL is used. Clicking focuses an existing client or opens `/`; ordinary
sync then recovers changes. No fetch interception or offline mailbox cache is added.

Disabling removes credential-local subscriptions and unsubscribes the browser.
A local hash binds the server subscription id to the current browser endpoint and
keys; replacements and VAPID-key changes require explicit resubscription.
Permission revocation and expired authentication suppress notifications. Provider
expiry may require enabling again; key rotation requires resubscription. The UI
checks pending verification automatically for up to one minute while visible and
shows distinct delivery errors or an unconfirmed timeout. Worker acknowledgments
notify open windows of success or sanitized HTTP/network/response failures, never
including codes, endpoint URLs or response bodies. Explicit retry cancels the old
subscription and creates a new verified-destination challenge; it does not resend
the old challenge. A lost verification
is recovered by cancelling and enabling again, subject to registration limits.

The CLI continues to use JMAP change-state polling for wait workflows; browser
permission and service-worker registration are not CLI authentication mechanisms.
Tests cover encryption/decryption, VAPID signature/audience, subscription lifecycle,
authorization, bounded delivery failures and generic browser handling. Actual browser
push-service delivery (including platform `userVisibleOnly` enforcement when stale
sessions suppress a push) still requires an operator-configured real-device smoke
test; local fixtures do not establish independent push-service interoperability.

Provider verification diagnostics record only subscription id, HTTP status and
acceptance, or a fixed failure category/network error code. These logs never
contain endpoint URLs, response bodies, push keys or verification secrets.
