# Detached Hail Bodies

Status: Draft

This document defines publication, content addressing, authorization, retrieval, verification, caching, and retention for detached Hail Bodies.

A Hail Envelope carries a compact descriptor for a body that already exists on the sender's Hail server. A recipient server retrieves or reuses that body only after authorizing the envelope.

This document defines Safe Portable Text body semantics and treats the encoded body as immutable bytes.

## Core Rules

- The complete body must exist before any referencing envelope is submitted.
- A published body is immutable.
- The body digest covers exact uncompressed deterministic body bytes.
- HTTP compression is a transport concern and does not change body identity.
- The body endpoint is derived from the sender DID's authenticated `#hail` service.
- Envelopes must not contain arbitrary body URLs.
- The recipient server pulls a body only after envelope authorization.
- One body may be referenced by envelopes for many recipients.
- Every recipient envelope carries separate retrieval authorization.
- Recipient servers may deduplicate exact body storage by digest; retrieval may be skipped only with matching recipient-and-sender cache provenance.
- Every envelope commits to at least 30 days of body availability from its creation time.
- A shared body remains available through the latest `available_until` value in any referencing envelope.
- Body retrieval is a server action and does not indicate that a user opened or read a message.

## Publication Before Submission

Before submitting a Hail Envelope, the sender:

1. Constructs the complete body document.
2. Encodes it into the deterministic uncompressed byte representation.
3. Computes its body digest and uncompressed size.
4. Stores the exact bytes in immutable content-addressed storage.
5. Makes the body available through its authenticated Hail service.
6. Creates recipient-specific body access authorization.
7. Constructs and signs each recipient envelope.

An envelope must never refer to a body that the sender intends to generate later. This avoids acceptance races, inconsistent personalized content, and hash commitments to unavailable data.

## Deterministic Body Bytes

In the current alpha, a plain Hail Body is a Safe Portable Text `spt-1` map in the Hail Data Model defined by [encoding.md](encoding.md). The additive `spt-2` profile permits headings, blockquotes, captions, lists, the `strong`/`em`/`code` decorators, and declared HTTPS link annotations. Conforming providers MUST support validation, retrieval, and storage of all three current profiles: `spt-1`, `spt-2`, and `spt-3`. Plain-text-only body support is insufficient for provider conformance.

### Text alignment and calls to action

In the current alpha, each `spt-2` text block (including those in `spt-3`) MAY
include `alignment` equal to `left`, `center`, or `right`. Absence means `left`;
explicit left and absent alignment have equivalent presentation. This is a
physical alignment hint for the block, including list item text; it does not
change document order, text direction, or list levels. Readers MAY adapt it for
accessibility. Arbitrary CSS values and alignment on image blocks are prohibited.

The `cta` text style represents a prominent navigation link. It uses the existing
`block`, `span`, and `spt.link` annotation structures, not executable controls.
A CTA MUST have exactly one link annotation, no `listItem` or `level`, and every
span MUST carry exactly that annotation key with no decorators. Concatenated span
text is its label: at most 128 UTF-8 bytes, containing at least one character other
than ASCII space/tab/CR/LF, with CR and LF prohibited. Span segmentation and
consistent annotation-key renaming do not change meaning. The destination uses
the existing absolute HTTPS/no-credentials rules and is at most 2048 UTF-8 bytes.
The annotation's optional title retains its existing meaning. A CTA supports the
same bounded alignment field, and all normal body/node/depth limits still apply.

Readers render the CTA as an accessible link with client-selected button styling
and adequate contrast, preserving label and destination. Its destination is loaded
only upon explicit navigation; rendering MUST NOT fetch it or create link previews.
A client without button styling can render the same labeled link; unknown or
invalid fields MUST NOT be silently discarded. Provider support for these current
`spt-2`/`spt-3` definitions is mandatory, without negotiation or silent downgrade.
Upgrade codecs, provider and clients together before publishing the expanded alpha
vocabulary. `spt-1` remains unchanged and rejects alignment or CTA styling.

The `spt-3` alpha profile retains `spt-2` text and interleaves 1 to 24
`spt.image` blocks with text in document order. Each image references a verified
bundled static PNG or JPEG asset by ID. The manifest contains 1 to 24 `image` or
`header` assets, all referenced; a `header` reference is permitted only at block
zero. The same asset may be referenced again, but each image occurrence counts
against the 24-block and eight-million-pixel display budgets. Each image is at
most 512 KiB, 2400 × 2400 and two million pixels (`header` height remains 1200).
These limits were set from measured email newsletters (2026-11-11): 24 blocks and
512 KiB admit most of their images while the complete body stays inside 1 MiB.
The complete deterministic body remains at most 1 MiB, with the standard encoding
node/depth/array limits; no new nesting is introduced. See [assets.md](assets.md).
Image blocks require meaningful, nonempty NFC plain-text `alt` and permit a
nonempty `caption`, each at most 1024 UTF-8 bytes under the profile text rules.
Empty decorative alternatives, image links, other formats, and remote loading
remain unsupported. Readers preserve image order and aspect ratio without
cropping. Unknown nodes/fields are rejected, never silently dropped.

All conforming providers MUST support this current `spt-3` definition; no optional
negotiation or downgrade is introduced. Upgrade providers and clients together
before publishing inline-image bodies: previous alpha implementations reject them.
Existing single leading headers remain a valid distinct presentation. Never
rewrite stored signed body bytes to upgrade their representation.

### Relayed origin

An `spt-2` or `spt-3` body MAY contain one `origin` member. It is the sender's
signed statement that it obtained the content from an external source and
relayed it, for example a bridge that receives email and delivers it as a hail.
`spt-1` is unchanged and MUST NOT contain `origin`.

`origin` is covered by the body digest and therefore by the envelope signature.
It attests only what the **sender** says about where the content came from. It
is not evidence of who wrote the content, and it grants no authority: delivery
is authorized exactly as for any other body from that sender. A recipient that
does not trust the sender has no reason to trust its `origin`.

The only current origin type is `email`:

| Member | Requirement |
| --- | --- |
| `type` | `email` |
| `from_address` | The author address the sender read from the message. Lowercase ASCII `local@domain`, at most 254 bytes, local part at most 64 bytes and limited to dot-separated RFC 5322 `atext`; the domain is lowercase LDH labels (A-labels for internationalized names) with at least two labels. |
| `from_name` | Optional display name: NFC plain text of 1 through 256 UTF-8 bytes without control or format characters. |
| `list_id` | Optional mailing-list identifier: 1 through 255 bytes of lowercase ASCII letters, digits, `.`, `_` and `-`, beginning and ending with a letter or digit. |
| `authentication` | `dkim-aligned` or `none`. |
| `received_at` | Integer timestamp at which the sender received the source message. |

`dkim-aligned` means the sender verified a DKIM signature on the source message
whose signing domain is the `from_address` domain or shares its registrable
domain. Any other outcome, including a valid signature for an unrelated domain,
is `none`. This is the sender's report of its own check; recipients cannot
re-verify it from the body. Unknown origin types, authentication values and
members are rejected, never ignored.

Readers that display `origin`:

- MUST keep the verified Hail sender visible and distinct from the origin. The
  origin address is never presented as a Hail address, a verified identity or
  the sender of the hail.
- MUST indicate that the content was relayed, and SHOULD show `authentication`
  when it is `none`.
- MUST NOT use `origin` for authorization, reply addressing, contact matching
  or sender-avatar selection.

A reader MAY ignore `origin` for presentation, but a provider MUST still
validate it. Origin does not change what a body may contain: links, images and
size limits are those of its profile.

A participant that forwards or quotes a relayed body is composing new content
and MUST NOT copy the original `origin` into it. Whether an account may state an
origin at all is provider policy; the reference provider accepts `origin` only
from a relay service it operates and rejects it in messages composed through the
account API.

The sender encodes the document using deterministic Hail CBOR. Those bytes are the deterministic body bytes.

Diagnostic JSON for an example source document:

```json
{
  "version": 1,
  "profile": "spt-1",
  "blocks": [
    {
      "_type": "block",
      "style": "normal",
      "children": [
        {
          "_type": "span",
          "text": "Hello from Hail.",
          "marks": []
        }
      ],
      "markDefs": []
    }
  ]
}
```

An `spt-2` text block has `_type: "block"`, one of the styles `normal`, `h1`,
`h2`, `h3`, `blockquote`, `caption`, or `cta`, at least one span, and an array of link
definitions. A list block additionally has `listItem: "bullet"` or `"number"`
and may have `level` from 1 through 3. A level is prohibited without
`listItem`.

A span's marks are unique and may contain `strong`, `em`, `code`, and at most
one key from that block's `markDefs`. A mark definition is a closed
`spt.link` map with a unique 1–64 character ASCII key, an absolute HTTPS URL
without embedded credentials, and optional plain-text title. Unknown styles,
marks, definitions, fields, and URL schemes are rejected.

Senders MAY select any of the three required profiles without capability discovery.
`spt-1` remains a distinct plain-text representation, not a mandatory fallback for
rich content. Safe Portable Text is an evolving Hail format; support for these
profiles does not imply support for arbitrary Portable Text or future layout nodes.
An extension adding new layout semantics MUST specify its profile identifier,
schema, resource limits, and support requirements. Providers MUST NOT silently
discard unknown nodes or reinterpret an unsupported profile as a supported one.
Discovery/negotiation for future optional profiles remains to be specified; it is
not a prerequisite for using the three current mandatory profiles. Client rendering
and accessible presentation are separate from provider wire conformance.

The exact deterministic bytes are stored and served. A receiver hashes the bytes it receives after removing HTTP content coding; it does not use a reserialized document to reproduce that digest. After the raw-byte digest succeeds, it performs bounded CBOR decoding, re-encodes under the deterministic Hail profile, and requires the result to equal the received bytes.

## Body Digest

The POC uses SHA-256 over the exact deterministic body bytes.

Inside a Hail payload, the digest value is exactly 32 bytes. Diagnostic JSON and HTTP text boundaries use unpadded base64url as defined by RFC 4648.

The retrieval path uses the digest's exact unpadded base64url rendering as its `{digest}` segment. It is exactly 43 ASCII characters, uses no `=` padding or percent encoding, and decodes to exactly 32 bytes.

Diagnostic JSON for a conceptual descriptor fragment:

```json
{
  "algorithm": "sha-256",
  "value": "base64url-sha256-digest"
}
```

The digest identifies content, not a delivery or message. Different envelopes may reference the same digest.

The digest is not secret. Implementations must not treat knowledge of it as authorization to retrieve the body.

## Envelope Body Descriptor

Every envelope contains a signed body descriptor.

Diagnostic JSON for the conceptual v0 shape. Byte-string values use their base64url diagnostic rendering:

```json
{
  "body": {
    "digest": {
      "algorithm": "sha-256",
      "value": "base64url-sha256-digest"
    },
    "size": 8421,
    "media_type": "application/hail-body+cbor",
    "profile": "spt-1",
    "available_until": 1790443200,
    "access": {
      "type": "bearer",
      "token": "base64url-random-token",
      "expires_at": 1790443200
    }
  }
}
```

The final placement, naming, and closed v0 schema of this descriptor are defined in [envelopes.md](envelopes.md).

### `digest`

The content digest of the exact uncompressed deterministic body bytes. Its `value` is a 32-byte byte string.

### `size`

The exact uncompressed byte length. A recipient checks this limit before retrieval and enforces it while streaming and decompressing the response.

### `media_type`

The POC value is `application/hail-body+cbor`. This media type is provisional until registration or final specification.

### `profile`

The plain POC value is `spt-1`, rich text is `spt-2`, and rich text with a
bundled images use `spt-3`.

### `available_until`

The minimum UTC Unix timestamp through which the sender commits to serving the body.

It must be at least 30 days and no more than 31 days (2678400 seconds) after the envelope's `created_at` time. The bearer `access.expires_at` must also be no later than that 31-day bound and no earlier than `available_until`. A body reused by a later envelope receives a correspondingly later availability commitment.

### `access`

Recipient-specific retrieval authorization covered by the envelope signature.

## Retrieval Authorization

The current alpha requires both a recipient-specific, per-envelope opaque token
and [RFC 9421 recipient proof](retrieval-signatures.md). Recipient DID and message
ID scope the authorization record. Token possession alone does not authorize
retrieval; the requester must also prove possession of the recipient's current
`#hail-messaging` key.

The sender generates exactly 256 bits of cryptographically secure random data and places those 32 bytes in the envelope. The same token may be reused for retries of the same envelope but must not be reused for another recipient or unrelated envelope. HTTP renders it with unpadded base64url.

The sender's authorization lookup stores a cryptographic digest of the token, mapped to:

- body digest
- recipient DID
- envelope or message ID
- expiration
- authorization status

The sender includes the original token in the recipient's signed envelope. The envelope signature prevents an intermediary from changing which token, body, recipient, or expiration the sender authorized.

Retained signed envelopes also contain the original token. Hashing the lookup
record does not remove that secret from retained envelopes, outboxes, or transfer
history; those representations require secret-bearing data protection and log
redaction.

The recipient presents the token in the HTTP `Authorization` header, never in the URL:

```http
GET /hail/bodies/{digest}
Authorization: Bearer base64url-random-token
Accept: application/hail-body+cbor
Accept-Encoding: gzip
Signature-Input: hail=("@method" "@target-uri" "authorization");...
Signature: hail=:...:
```

The signature fields above are abbreviated; use the exact
[retrieval signature profile](retrieval-signatures.md#exact-signature-profile).

The POC uses the Bearer authentication scheme syntax defined by RFC 6750 without adopting OAuth token issuance or authorization flows.

Query-string tokens are prohibited because URLs commonly appear in access logs, browser history, monitoring systems, and referrer data.

The sender accepts retrieval only when:

- the token digest matches an active authorization record
- the requested body digest matches the authorized body
- the authorization has not expired
- the token is presented over HTTPS
- the required recipient HTTP signature passes freshness and atomic replay checks

Missing or invalid tokens and recipient signatures, replay, failed key resolution
and pre-authorization lookup failures share a concealed `404`. The recipient
refreshes sender routing, then retries with a fresh signature within the delivery
deadline. A concealed response is not proof of permanent authorization failure.
Only after both proofs pass may missing/corrupt body bytes or a temporary source
fence disclose retryable `503`; a retired source uses `404` to trigger endpoint
refresh. See [the complete failure schedule](retrieval-signatures.md#concealment-and-resource-limits).

## Signatures Versus Encryption

A signature is created with a private key and verified with a public key. A token cannot be "signed with the receiver's public key."

The token could be encrypted to a recipient public key, but Hail v0 does not otherwise provide end-to-end envelope encryption. Encrypting only the retrieval token would add key-agreement and recovery complexity without protecting the rest of the envelope metadata.

For the POC, HTTPS protects the envelope in transit and the sender's `#hail-messaging` signature authenticates the token and body descriptor.

## Recipient Proof Of Possession

The required [RFC 9421 retrieval profile](retrieval-signatures.md) combines the
envelope-bound token with a request signed by the recipient's current messaging
key. The same profile covers body and attachment requests. This transport proof
does not replace envelope signatures or the recipient's body integrity checks.

## Shared Bodies

The sender stores one immutable body blob per digest, regardless of how many recipient envelopes reference it.

Recipient authorization remains separate:

```text
body digest -> one stored blob
token A     -> recipient A + body digest
token B     -> recipient B + body digest
token C     -> recipient C + body digest
```

This preserves body deduplication while preventing the digest itself from becoming a public retrieval capability.

Personalized bodies naturally produce different deterministic bytes and digests. Senders must not claim two bodies are shared unless every byte is identical.

## Recipient Deduplication

A recipient server may already possess verified deterministic bytes for a digest from an earlier delivery to the same recipient from the same sender.

After authorizing an envelope, the server may satisfy body retrieval from its local content-addressed cache only when the cache has verified provenance for the same recipient DID and sender DID, and when:

- the cached byte length equals the envelope size
- the cached digest was previously verified
- the media type and profile match
- local retention policy permits reuse

The server does not need to redeem another token for a cache entry with matching recipient and sender provenance. Cross-recipient cache presence must not determine delivery behavior. v0 performs recipient-specific retrieval when matching provenance is absent; coordinated cross-recipient retrieval requires a future privacy-preserving authorization profile.

Consequences:

- underlying storage may deduplicate bytes without exposing cross-recipient cache membership
- body fetch counts are not reliable delivery counts
- body fetches must never be treated as opens or reads
- senders receive delivery state through the delivery protocol, not tracking requests

## Retrieval Endpoint

The body endpoint is derived from the sender DID's authenticated `#hail` service base URL.

Retrieval endpoint:

```text
{hail-service-base}/bodies/{digest}
```

Retrieval uses `GET`. The relative operation path, no-trailing-slash rule, and exact unpadded base64url digest segment are defined by the HTTP binding.

An envelope does not carry a full body URL. This prevents envelopes from directing recipient servers to arbitrary networks or hosts.

v0 retrieval does not follow redirects. A provider migration is represented by updating the DID's `#hail` service and is handled by the canonical endpoint comparison and DID re-resolution rules in the HTTP binding, not HTTP redirection. A retry at a newly authenticated endpoint uses the same digest and token within its original validity period, with a fresh signature covering the new target and a new nonce.

## Retrieval Response

Successful response:

```http
HTTP/1.1 200 OK
Content-Type: application/hail-body+cbor
Content-Encoding: gzip
Cache-Control: private, no-store
Content-Digest: sha-256=:base64-standard-digest:
```

The RFC 9530 `Content-Digest` header is recommended as transport-level integrity metadata. It hashes the HTTP message content, including gzip-coded bytes when `Content-Encoding: gzip` is present. The digest committed by the signed envelope separately hashes the uncompressed deterministic body bytes and remains authoritative for Hail content identity.

Receivers parse a present field as an RFC 9651 Structured Fields Dictionary,
combining multiple field lines with commas in received order. This retrieval
profile limits the combined field value to 8192 ASCII octets and the parsed
dictionary to 16 distinct algorithm keys. Parsing failure, a limit violation,
or a dictionary member whose value is not a Byte Sequence fails retrieval with
`body-integrity-failed`. Duplicate keys use the last value as specified by
Structured Fields; parameters are parsed and ignored, including unknown ones.

Receivers MUST validate every present supported algorithm (`sha-256` and
`sha-512`) against the HTTP content bytes; a mismatch or incorrect digest length
fails with `body-integrity-failed`. Other well-formed algorithm entries are
ignored. An absent field, empty dictionary, or dictionary containing only
unsupported algorithms supplies no transport integrity evidence and does not
itself fail retrieval. In every case the signed uncompressed size/digest and
body validation remain mandatory. A valid HTTP digest cannot authorize content
or replace those checks. This profile does not require trailer-field processing;
senders cannot rely on a trailer digest being checked. The same rules apply to
detached attachment responses, whose signed declaration remains authoritative.
See [digest vectors](vectors/content-digest.json).

The response body may use an allowed HTTP content coding. After bounded decompression, the recipient verifies:

1. Uncompressed byte length exactly equals the declared `size`.
2. SHA-256 digest exactly equals the envelope digest.
3. HTTP media type equals the declared media type.
4. Body profile equals the declared and supported profile.
5. The bytes exactly equal the deterministic Hail CBOR re-encoding of the parsed item.
6. The SPT document passes strict schema and resource-limit validation.

The recipient does not render or store the message as delivered until all checks succeed.

## Compression

Compression is outside body identity.

```text
deterministic uncompressed bytes -> size and SHA-256 body digest
HTTP content coding          -> transfer optimization only
```

The same body may be transferred with no content coding or an allowed coding such as gzip without changing its digest.

Recipients MUST enforce a hard decompressed-output limit during decompression;
checking size only after an unbounded decompression call is prohibited. Streaming
and bounded buffered decompression are both permitted. A buffered implementation
MUST bound compressed input before decompression and configure the decompressor's
output cap to the signed body size, itself validated against the body ceiling.
Bounded decoder scratch space is separate from logical output; buffering does not
permit an output cap above the signed size. The final output must have exactly the
signed length and digest before decoding or delivery.

## Current Alpha Resource Limits

The current alpha supports the bundled `spt-3` image assets, detached
[PNG/JPEG/WebP/PDF/TXT/LOG attachments](attachments.md), and a maximum uncompressed body size of 1 MiB (1048576 octets). Conforming
providers MUST support valid bodies through that size, subject to authorization,
schema validation, and explicit resource/policy failures; they MUST NOT advertise
conformance with a smaller format ceiling. The header itself is limited to 192
KiB, 2400 by 1200 pixels, and 2,000,000 pixels total.

The receiver enforces:

- envelope-declared size no greater than 1 MiB
- bounded compressed response bytes
- decompression output capped at the declared size, whether buffered or streamed
- exact final uncompressed size
- Safe Portable Text depth, node-count, and string-length limits
- request and response timeouts

This is the current interoperable body ceiling, not a promise of unlimited storage
or delivery capacity. Larger publisher layouts or attachment formats require an
explicit specification change; a provider-local increase does not create peer
support. Receivers MUST support identity and gzip HTTP content coding. Serving
uncompressed bytes is sufficient; gzip emission is optional. Gzip-coded responses
MUST NOT exceed 2097152 octets, and decompressed bytes MUST match the signed size
within the body ceiling. No other content coding is defined by this profile.

### Separate Content Budgets

The 1 MiB ceiling covers the complete deterministic SPT document, including any
bundled asset bytes and CBOR metadata. Text/layout complexity also obeys the
independent depth, item and collection budgets in [encoding](encoding.md).
Each bundled image retains its own 512 KiB, dimension and pixel limits;
increasing the body ceiling does not increase any image limit.

Detached [attachments](attachments.md) have a separate 25 MiB aggregate budget
and 20-file limit. Their metadata is authenticated inside the body; their bytes
are retrieved separately before delivery. Remote image resources remain deferred.
Provider quotas and concurrent-transfer budgets remain separate from wire limits.

Publisher layouts are intended to express safe HTML-like content through explicit
SPT nodes and validated attributes. The larger budget does not permit arbitrary
HTML, CSS, scripts, remote resource loading, or unknown nodes. New layout semantics
require a specified profile and client presentation rules.

## Retention

The sender must retain the exact body bytes and each retrieval authorization through that envelope's signed `available_until` value. For a shared body, storage continues through the latest `available_until` value among all referencing envelopes.

Each envelope commits to at least 30 days from its `created_at` time. Retries of the same envelope do not extend that signed commitment. A sender may commit to and provide a longer period.

Recipient servers should attempt retrieval promptly. After successful verification, the recipient becomes responsible for its stored copy under its own retention policy.

If the sender removes or changes a body before `available_until`, it has violated the delivery contract. Content at the same digest path must never change; different bytes necessarily have a different digest.

After `available_until`, an incomplete delivery fails permanently. Voluntary continued service does not extend the signed delivery deadline or permit another retry of the accepted envelope.

## Retry Behavior

Transient network and server failures may be retried with bounded exponential backoff and jitter until `available_until` or 300 seconds after the envelope's `expires_at` delivery deadline, whichever occurs first. The 300 seconds are the envelope's clock tolerance, not an extension of body availability.

The same token is valid for multiple retrieval attempts until its expiration. Retrieval is not single-use because interrupted streams and recipient recovery require retries.

Delivery state, retry ownership, and reason codes are defined in [delivery-state.md](delivery-state.md). Body retrieval follows these classifications:

- temporary retrieval failure: retry
- rate limited with `Retry-After`: retry as directed
- invalid or mismatched authorization: permanent failure
- authorization expired: permanent failure
- body unavailable before commitment ends: retry and record sender fault
- body unavailable after commitment ends: permanent failure
- size, digest, media type, or schema mismatch: permanent integrity failure

The exact HTTP status mapping and disclosure-safe RFC 9457 behavior are defined in the Hail HTTP binding. In particular, a uniform `404` triggers sender-DID refresh and bounded retries with fresh signatures until the effective delivery deadline; it does not prove permanent authorization failure. A temporarily missing committed body under valid authorization uses retryable `503`, and rate limiting uses retryable `429`.

## Privacy And Analytics

Body retrieval occurs between servers shortly after envelope authorization. It reveals neither a user open nor a read.

Recipient caching, proxying, and storage deduplication are explicitly allowed within the provenance rules above. Body fetches and token redemption are server delivery operations and do not indicate user engagement.

Remote resources inside SPT content remain prohibited. `spt-3` bundles verified
image bytes in the body so rendering causes no sender-visible request. Body
retrieval authorization must not become a covert tracking channel.

## Security Considerations

### Bearer Token Leakage

Anyone possessing a token can retrieve its authorized body until expiration while
the authorization remains active. Tokens must be generated securely, transmitted
only over HTTPS, excluded from URLs and logs, and hashed in authorization lookup
records. Both providers must protect retained signed envelopes containing the
original token.

### Server-Side Request Forgery

Recipients derive the body endpoint only from the authenticated DID service. They do not accept envelope-supplied URLs or redirects. DNS rebinding and private-network protections from the Hail DID profile still apply.

### Content Guessing

A body digest may be guessable when content is public or predictable. Retrieval still requires recipient authorization; the endpoint must not serve a body based only on its digest.

### Token Enumeration

At least 256 random token bits make online guessing infeasible. The sender must rate-limit failures. Before successful token-and-signature authorization, a `429` may be selected only by a source-wide or service-wide limit independent of token validity, authorization-record existence, and body existence; otherwise the request receives the uniform `404`. After valid authorization, an authorization-scoped limit may return `429`, and only a caller presenting both valid proofs for the requested digest may receive `503` for a temporarily missing committed body.

### Decompression Bombs

The declared uncompressed size is enforced during decompression. Implementations
must not trust `Content-Length`, compressed size, or gzip metadata as an output
bound. Concatenated gzip members share one aggregate output budget. Truncated
input remains retryable as `body-transfer-interrupted`; corrupt gzip or excess
output fails integrity validation. Implementations should bound concurrent work
and avoid long synchronous decompression on a request-serving event loop.

### Shared-Body Correlation

The same digest indicates byte-identical content. DIDs and envelopes are not globally published by Hail, but providers that observe several envelopes may infer shared campaign membership. End-to-end encrypted bodies may require a different deduplication design later.

## POC Requirements

The proof of concept implements:

- body creation before envelope submission
- immutable deterministic-CBOR `spt-1`, `spt-2`, or `spt-3` bytes
- SHA-256 digest over uncompressed bytes
- 32-byte digest values with unpadded base64url HTTP rendering
- exact uncompressed size declaration
- provisional `application/hail-body+cbor` media type
- recipient pull from the authenticated sender Hail service
- one random 256-bit bearer token per recipient envelope
- token presentation in the HTTP `Authorization` header
- mandatory [RFC 9421 recipient proof](retrieval-signatures.md) and durable replay rejection
- one stored body shared by many authorization records
- recipient caching and digest deduplication
- no redirects or arbitrary body URLs
- gzip transfer support
- 1 MiB maximum uncompressed body size
- 30-day minimum availability commitment
- bounded retries and strict integrity validation

Deferred:

- end-to-end encryption
- asset formats beyond bundled static PNG images
- attachment formats beyond PNG/JPEG/WebP/PDF/TXT/LOG
- remote asset profiles
- content negotiation beyond the POC profile
- larger body profiles and their interoperable limits

## Remaining Publication And Extension Work

- Register `application/hail-body+cbor` or explicitly revise the profile if review
  requires a different allocation. Implementations use the current exact value;
  they do not choose substitute strings locally.
- Define support discovery before introducing optional body profiles. The current
  three profiles are mandatory and need no such negotiation.
- Specify future layout and additional attachment profiles, including their size and delivery
  semantics. Bearer authorization per envelope and identity/gzip coding are settled
  for the current alpha; proof of possession remains a separate future extension.
