# Reference-provider inbound email bridge

Status: reference-provider policy, partly implemented. This is not a federation
operation and no provider is required to offer it. The only protocol element it
uses is the signed [relayed-origin](bodies.md#relayed-origin) body member.

Implemented: aliases, the ingress contract, conversion, the converter worker,
delivery as the bridge's account, the account API and web client screens, permanent
edge deletion records, consented one-click unsubscribe, and
a [Cloudflare ingress adapter](../apps/server/deploy/cloudflare-email-worker/README.md).
See the
[implementation plan](../agents/email-bridge-plan.md).

## Model

The bridge is an ordinary Hail sender operated by the provider. A user grants it
permission like any other sender, then creates **aliases** for email
subscriptions. One alias per subscription gives independent control; an alias
can also be shared by multiple subscriptions. Mail sent to an alias is converted
to a body and delivered to that user as a normal Grant-authorized hail whose body states its `email` origin.

- The bridge only receives. It never sends email, including bounces,
  auto-replies and unsubscribe emails. With explicit user consent it can send
  HTTPS one-click unsubscribe requests, as specified below.
- An alias is the user's consent to receive mail at that address. Removing it
  stops all mail to it without any sender's cooperation. Revoking the Grant stops
  all of them.
- An alias address is not a Hail address. The alias domain MUST differ from the
  provider's Hail address domain.

## Aliases

An alias address is `LOCAL@DOMAIN`, where `DOMAIN` is the configured alias
domain and `LOCAL` is twelve characters of lowercase RFC 4648 base32
(`a`–`z`, `2`–`7`): sixty random bits. The local part is the alias's only secret.

| State | Mail | Notes |
| --- | --- | --- |
| `active` | accepted | |
| `paused` | refused | The address is kept and can be resumed. |
| `deleted` | refused | Permanent. The address is never issued again, and mail still queued for it is discarded. |

Each alias has a user-chosen label of 1 through 160 UTF-8 bytes. An account may
hold a bounded number of live aliases (50 by default). Aliases are provider-local
state: they are not part of either account transfer format, and an account that
is fenced for transfer can neither receive bridged mail nor create aliases.

## Ingress contract

The provider does not receive SMTP. Whatever accepts mail for the alias domain
is an **ingress adapter**: a small component at the mail edge that calls the two
operations below. The contract names no mail vendor, and the provider contains
no adapter-specific behaviour.

The intake operations and deletion feed are `POST` requests authenticated with
`Authorization: Bearer TOKEN`, where `TOKEN` is a 32-byte secret in unpadded
base64url that is used for nothing else. Responses are `Cache-Control: no-store`.

### Check a recipient

`POST /email-bridge/v1/intake/check` with `Content-Type: application/json` and
body `{"recipient":"LOCAL@DOMAIN"}`. The adapter calls it before accepting
message data. The response is `200` with one of:

| `result` | Meaning for the SMTP transaction |
| --- | --- |
| `accept` | Accept the message, then submit it. |
| `reject` | Refuse permanently. |
| `defer` | Refuse temporarily; the sender should retry later. |

The reason is never returned. Unknown, malformed, paused and deleted aliases,
and aliases of closed or transferring accounts, all produce `reject`, so the
response cannot be used to learn alias state. `defer` reports a rate or storage
limit.

### Submit a message

`POST /email-bridge/v1/intake/messages` with `Content-Type: message/rfc822`, no
content coding, and the unmodified message bytes as the body.

| Header | Requirement |
| --- | --- |
| `Bridge-Recipient` | Required. The envelope recipient the message was accepted for. |
| `Bridge-Received-At` | Required. Receive time in whole seconds since the Unix epoch. |
| `Bridge-Envelope-Sender` | Optional SMTP envelope sender, at most 320 bytes. |
| `Bridge-Source-Address` | Optional IP address of the host that delivered the message. |

A message for several aliases is submitted once per recipient. The response is
`200` with one of:

| `result` | Meaning |
| --- | --- |
| `accepted` | Durably stored for conversion. |
| `duplicate` | Already held for this alias. Treat as accepted. |
| `reject` | Refuse permanently. |
| `defer` | Refuse temporarily. |

A message larger than the provider's limit (10 MiB by default) receives `413`
with `{"result":"reject"}`.

Two submissions for the same alias are the same message when they carry the
same `Message-ID`, or, when there is none, when their bytes are identical. A
resend is reported as `duplicate` even when the alias is over a limit, so that
the sender stops retrying.

Limits apply per alias per hour, per account per day, and to the bytes of
original messages an account has awaiting conversion. Their values are provider
policy.

### Permanent deletion feed

`POST /email-bridge/v1/deletions`, with `Content-Type: application/json` and
`{"after":"0"}`, returns `{"deletions":[{"sequence":"1","localPart":"abcdefghijkl"}]}`.
The same ingress credential is required. This endpoint exposes permanent deletion
state to a trusted adapter; it MUST NOT be exposed to unauthenticated callers.
It does not change the indistinguishable replies of the recipient check.

`after` is a canonical nonnegative decimal string no greater than
9223372036854775807. Sequences are positive decimal strings to preserve bigint
precision. At most 500 entries strictly after the cursor are returned in numeric
sequence order; gaps are allowed. An empty page means caught up. Invalid cursors
return 400, unauthorized calls 401, non-POST calls 405, and non-JSON calls 415.

Publication is commit-ordered: deletion transactions serialize sequence allocation
through commit. The migration backfills previously deleted aliases. Records never
expire, survive account removal, and permanently reserve their local parts. Only
permanent alias deletion publishes a record; pause, Grant revocation, account
fencing, unknown recipients and quota refusals do not.

An adapter MAY use these records to reject recipients without contacting the
provider. It MUST durably write every record in a page before advancing its
cursor, tolerate replay, and fall back to the provider for a missing record or
unavailable edge storage. It MUST NOT permanently cache a generic `reject` reply.
Propagation is asynchronous; provider checks enforce deletion immediately.

The Cloudflare adapter keeps records and its cursor in a separate R2 bucket with
no expiration policy. A one-minute scheduled handler copies at most 500 records
per invocation. The apex catch-all still sends mail to the Worker; a matching
record avoids the provider request and body read, not the Worker invocation or
Cloudflare's SMTP receipt. Retry processing checks recipient eligibility before
retrieving a held R2 body; reject deletes and acknowledges it, while defer or an
outage keeps it for the existing bounded retry policy.

### Adapter requirements

- Decide during the SMTP transaction wherever the edge allows it. An edge that
  can only decide after accepting a message MUST discard a refused message
  silently.
- MUST NOT generate a bounce or any other email.
- MUST treat a network failure, a timeout or any response other than those
  defined above as `defer`. It MUST NOT accept mail it could not hand over,
  unless it keeps that mail durably and submits it later; mail refused at that
  point is discarded silently.
- MUST pass message bytes unmodified apart from trace headers the edge itself
  prepends. The provider verifies DKIM from those bytes; an adapter's own
  authentication results are not trusted.
- SHOULD give `reject` one fixed SMTP reply for every recipient, so the reply
  reveals nothing beyond the refusal.
- An edge that cannot send a temporary SMTP failure MAY refuse on `defer`.

The alias domain needs to receive mail for arbitrary local parts. On
Cloudflare that means a dedicated zone: Email Routing allows a catch-all rule
only on a zone's apex.

## Handling of accepted mail

Each accepted message moves through these states:

| State | Holds | Next |
| --- | --- | --- |
| `queued` | The original message | Claimed by the converter |
| `converting` | The original message | `converted`, back to `queued` to retry, or `dead` |
| `converted` | The converted body | `delivered` or `dead` |
| `delivered` | Neither | Final: handed to ordinary Hail delivery |
| `dead` | Neither, plus a short failure reason | Final |

The original message is deleted as soon as it is converted or abandoned. The
record that remains holds no message body: it exists to recognize resends,
count against the limits above, and give the operator a failure reason. It also records the DKIM outcome: each signature's domain and result, and why a message was not verified. Eligible one-click unsubscribe metadata is retained as described below; its URL can contain a private subscription token.

Deleting an alias moves every message of that alias still in the first three
states to `dead`. A worker that finishes later finds its claim gone and writes
nothing.

### Conversion

The converter is a separate process. It parses untrusted mail and fetches
sender-chosen image URLs, so it holds no keys and uses a database role that can
read and update only the intake queue's processing columns
([role script](../apps/server/deploy/email-bridge/converter-role.sql)). The
provider process itself reads a message only far enough to find its
`Message-ID`.

A converter claims one message at a time with a lease of five minutes; a worker
that stops is replaced when the lease lapses. A message that cannot be
converted at all, such as one with no usable `From` address, is abandoned at
once. Other failures are retried with backoff, up to five attempts.

Conversion rules, including what is dropped and how images are bundled or
linked, are described with the
[conversion package](../packages/hail-email-bridge/README.md). Remote images are
fetched over HTTPS on port 443 from public addresses only, following at most
three redirects, within 15 seconds each and at most 48 per message. Requests ask
for PNG or JPEG and identify the bridge in `User-Agent`.

`authentication` is `dkim-aligned` only when the message has exactly one `From`
address, it is the address the converter read, and a DKIM signature verifies
for that address's domain or its registrable domain. A lookup failure or any
other outcome is `none`.

### Delivery

The provider delivers each converted body as an ordinary Grant-authorized hail
from the bridge's account, with replies disallowed. Before signing it
revalidates the body with the codec and requires an `email` origin, because the
converter's output is untrusted. The hail's message ID is assigned once, so a
retried delivery reuses the same envelope.

| Condition | Outcome |
| --- | --- |
| The alias is paused or deleted, or its account is closed, inactive or transferring | `dead` |
| The recipient holds no active Grant to the bridge for its category | `dead`: there is no consent to deliver |
| The body fails revalidation or has no `email` origin | `dead` |
| The receiving side refuses the envelope | `dead` |
| A transient failure | Retried with backoff, up to eight attempts |
| The bridge account is missing or inactive | Kept, and retried; this is the operator's to fix |

## Best-effort one-click unsubscribe

This is reference-provider policy implementing [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html),
not a Hail federation operation. Before discarding original message bytes, the
converter records eligible metadata only when one passing, From-aligned DKIM
signature covers both `List-Unsubscribe` and `List-Unsubscribe-Post`. Each header
MUST occur exactly once; the latter MUST equal `List-Unsubscribe=One-Click`.
The former must be a bracketed URI list containing exactly one HTTPS URI.
The reference provider accepts only canonical HTTPS DNS targets on port 443,
without credentials or fragments, at most 4096 UTF-8 bytes. Headers beyond the
first 64 KiB or ambiguous/unsupported values yield no automatic action.

The list key is SHA-256 of the lowercase signing domain, a newline, and either
`list:` plus the signed List-ID identifier or `url:` plus the exact endpoint.
An unsigned/missing List-ID uses the endpoint so distinct lists are not silently
merged. This fallback can produce multiple requests for rotating URLs from one
list. Deletion selects the latest accepted message per list key (UUID descending
breaks timestamp ties), considers at most 100 keys per alias in key order, and
deduplicates identical URLs. Older mail processed before this feature has no
eligible metadata. Lists with no supported endpoint need manual unsubscribe.

Alias destruction with `unsubscribe:true` is explicit consent to request removal
from supported lists using those aliases. In one transaction it marks the alias
deleted, publishes its deletion record, discards pending mail, snapshots eligible
metadata into jobs, and erases unsubscribe metadata from the intake records.
Without consent it queues no jobs but still erases that metadata. Delivered hails
are unchanged. A converter finishing after deletion cannot restore metadata or
mail. Repeating destruction returns notFound and cannot enqueue extra jobs.

A provider worker sends `POST` with `Content-Type: application/x-www-form-urlencoded`
and exactly `List-Unsubscribe=One-Click`, without cookies or authorization. It
uses the existing safe HTTPS transport: public-address-only DNS validation,
connection pinning, no redirects, and a ten-second deadline. Response bodies are
cancelled without parsing. A 2xx response marks `requested`, not proof that the
publisher removed the subscription. Network errors, 429 and 5xx retry with bounded
backoff, at most five claimed attempts; other statuses fail. Crash recovery may
repeat a request. Jobs erase their URL on either terminal outcome. Metadata URLs
and request errors containing them MUST NOT be logged. The converter can write
intake diagnostics but cannot create consented jobs or read their table.

Unsubscribe failure never delays or reverses alias deletion. Deletion records
are permanent; active-alias unsubscribe metadata currently shares intake-record
retention. A general retention policy remains an open item.

## Account API

Three typed operations under the `https://racrproto.com/ns/jmap/account`
capability manage inbound email. A provider without the bridge answers
`HailEmailAlias/get` with `{"available":false}` and refuses the others.

| Method | Arguments | Requires | Result |
| --- | --- | --- | --- |
| `HailEmailAlias/get` | optional `summary` (Boolean) | `messages:read` | The state below, plus `aliases` unless `summary` is true |
| `HailEmailAlias/create` | `label` | `messages:write`, browser session, inbound email on | `{"alias": ALIAS}` |
| `HailEmailAlias/destroy` | `ids`: 1 to 50 alias IDs; optional `unsubscribe` Boolean, default false | `messages:write`, browser session | `{"destroyed": [...], "notFound": [...], "unsubscribeRequests": 0}` |

The state is `{available:true, domain, sender:{address, category}, enabled,
grant}`. `enabled` is true when the account holds an active Grant to the bridge
for its category; `grant` then carries that Grant's `grantId`, `revision` and
`digest`, and is otherwise null. An alias is `{id, address, label, createdAt,
lastReceivedAt, messageCount}`, with RFC 3339 timestamps and
`lastReceivedAt` null until mail arrives. Create fails with `stateMismatch`
while inbound email is off. `unsubscribeRequests` counts newly queued requests,
not completed unsubscribes. Non-Boolean `unsubscribe` values are invalid.

Inbound email has no separate switch. Turning it on is an ordinary Grant to
the bridge account for its category, through the passkey-confirmed sender
approval; turning it off revokes that Grant. It therefore also appears, and can
be revoked, under Subscriptions. While it is off, intake refuses every alias of
the account, and existing aliases are kept.

## Reference web client

Following the reader requirements for a [relayed origin](bodies.md#relayed-origin),
Feed, Trash and message views name the email sender, labelled "via email", and
the message view names the bridge account as the Hail sender that relayed it
and says whether the sender's domain signed the email. Reply is not offered.
The ordinary Hail unsubscribe action is not offered: it would revoke the Grant
to the bridge and turn inbound email off for every alias. The view links to Aliases
instead. Alias deletion offers an unchecked option to request unsubscribe from
newsletters using the selected addresses, explains best-effort coverage, and
reports the number queued (or that none were available).

## Operator setup

1. Create a local account for the bridge, give it a Sender Profile with a
   category for bridged mail (`email` by default), and publish its address
   binding. This is the sender users grant. The reference provider reserves the
   name `email`, so it is claimed as a provider role rather than registered.
2. Set `EMAIL_BRIDGE_DOMAIN`, `EMAIL_BRIDGE_INTAKE_TOKEN`, `EMAIL_BRIDGE_SENDER`
   (that account's address) and, if not `email`, `EMAIL_BRIDGE_CATEGORY`. The
   provider refuses to start with only some of them.
3. After the provider has migrated, create the converter's database role as the
   database owner: [converter-role.sql](../apps/server/deploy/email-bridge/converter-role.sql)
   then [converter-login.sql](../apps/server/deploy/email-bridge/converter-login.sql),
   with the password set first. Start the converter with that password: the
   `email-bridge` Compose profile in the standalone deployment, or
   `EMAIL_CONVERTER_DB_PASSWORD` and `hail-provider-ops email-converter-role` on Haili.
4. Point the alias domain's mail at an ingress adapter that calls the contract
   above. For Cloudflare, retain the catch-all and configure the deletion bucket
   and schedule as described in the [adapter README](../apps/server/deploy/cloudflare-email-worker/README.md).

A user receives bridged mail after granting the bridge account its category,
through the same sender approval as any other publisher.

## Open items

- Retention period for intake diagnostics (including active-alias unsubscribe
  tokens), terminal unsubscribe jobs, and `dead` records.
- Telling which alias a delivered message arrived through, so a message view
  can offer to delete that alias.
- A storage ceiling for delivered bridged content. Current storage accounting
  measures usage and does not limit it.
- Whether aliases can continue after a provider transfer; see plan decision D8.

## Implementation conformance checks

- Unknown/paused/revoked aliases return the same recipient refusal and never
  become permanent edge records; deleting an alias publishes a durable record.
- Authenticated deletion-feed pages order sequences numerically, reject invalid
  cursors, and never skip an earlier uncommitted deletion.
- An edge hit rejects with no provider request or body read; failed page writes
  leave the cursor unchanged. Edge misses/storage failures use provider checks.
- Held-mail reject/defer/outage decisions occur before R2 body retrieval.
- Real DKIM test vectors reject unsigned, tampered, duplicate or incompletely
  covered unsubscribe headers, and distinguish signed list IDs from URL fallback.
- Deletion without consent makes no jobs; shared-alias deletion with consent
  queues distinct eligible lists, erases metadata, and preserves delivered mail.
- Redirects are not followed; private DNS targets are refused before connection;
  retries are bounded and terminal jobs erase their URL.

Executable checks: `cloudflare-email-worker.test.ts`, `email-unsubscribe.test.ts`,
`email-unsubscribe.integration.test.ts`, and the existing email-bridge pipeline and
migration suites under `apps/server/test/`.
