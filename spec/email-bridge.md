# Reference-provider inbound email bridge

Status: reference-provider policy, partly implemented. This is not a federation
operation and no provider is required to offer it. The only protocol element it
uses is the signed [relayed-origin](bodies.md#relayed-origin) body member.

Implemented: aliases, the ingress contract below, and email-to-body conversion.
Not yet implemented: the converter worker, the bridge's sender identity and
delivery, the account API and client screens, and any ingress adapter. See the
[implementation plan](../agents/email-bridge-plan.md).

## Model

The bridge is an ordinary Hail sender operated by the provider. A user grants it
permission like any other sender, then creates one **alias** per email
subscription. Mail sent to an alias is converted to a body and delivered to that
user as a normal Grant-authorized hail whose body states its `email` origin.

- The bridge only receives. It never sends email, including bounces,
  auto-replies and unsubscribe requests.
- An alias is the user's consent for one subscription. Removing it stops that
  sender without the sender's cooperation. Revoking the Grant stops all of them.
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

Both operations are `POST` requests authenticated with
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

### Adapter requirements

- Decide during the SMTP transaction wherever the edge allows it. An edge that
  can only decide after accepting a message MUST discard a refused message
  silently.
- MUST NOT generate a bounce or any other email.
- MUST treat a network failure, a timeout or any response other than those
  defined above as `defer`. It MUST NOT accept mail it could not hand over.
- MUST pass message bytes unmodified apart from trace headers the edge itself
  prepends. The provider verifies DKIM from those bytes; an adapter's own
  authentication results are not trusted.
- SHOULD give `reject` one fixed SMTP reply for every recipient, so the reply
  reveals nothing beyond the refusal.

## Handling of accepted mail

The original message is kept only until it has been converted or abandoned, and
is then deleted. The record that remains holds no message content: it exists to
recognize resends and to count against the limits above.

Parsing and image fetching run in a separate converter process that holds no
keys. The provider revalidates the converted body with the ordinary codec
before the bridge account signs it. The provider process itself reads a message
only far enough to find its `Message-ID`.

Conversion rules, including what is dropped and how images are bundled or
linked, are described with the
[conversion package](../packages/hail-email-bridge/README.md).

## Open items

- Retention period for the content-free intake record.
- A storage ceiling for delivered bridged content. Current storage accounting
  measures usage and does not limit it.
- Whether aliases can continue after a provider transfer; see plan decision D8.
