# Recipient proof for body and attachment retrieval

Status: required current alpha HTTP profile, `hail-retrieval-v1`, using
[RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html).
This profile is separate from client login/OAuth and from COSE object signatures.

## Both proofs are required

Every body and attachment GET MUST carry its existing per-envelope token in
`Authorization: Bearer <token>` AND a valid recipient HTTP signature. Possession
of a leaked token alone MUST NOT authorize retrieval. The signed envelope's
`access.type = "bearer"` continues to describe the token/header representation;
it does not select a bearer-only mode. No legacy fallback or negotiation exists.

First check canonical path/token, token hash, bound body digest, active status
and authorization expiry using local storage. Only then resolve the recipient
DID stored in that authorization record. Never choose a DID, key URL, algorithm
or key role based solely on untrusted signature parameters. Verify against the
current validated recipient `#hail-messaging` Ed25519 key, including the public
PLC evidence freshness rules. A removed key is not valid for new retrievals.
The sender's body token is still scoped to one envelope/recipient/body.

## Exact signature profile

Both fields are RFC 8941 dictionaries containing exactly one member, `hail`.
The inner list contains exactly these components, in order, without parameters:

```http
Signature-Input: hail=("@method" "@target-uri" "authorization");created=1800000000;expires=1800000060;nonce="CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";keyid="did:plc:bbbbbbbbbbbbbbbbbbbbbbbb#hail-messaging";alg="ed25519";tag="hail-retrieval-v1"
Signature: hail=:<standard-base64 64-byte Ed25519 signature>:
```

Exactly six parameters are required: integer `created` and `expires`, string
`nonce`, `keyid`, `alg`, and `tag`. `alg` is `ed25519`; `tag` is
`hail-retrieval-v1`; `keyid` is the authorized recipient DID plus
`#hail-messaging`. Other algorithms, labels, components, parameters, multiple
signatures and duplicate dictionary keys/parameters MUST be rejected. This
application profile requires canonical Structured Fields serialization (after
HTTP field-value whitespace processing), including canonical byte sequences.
Parameter order may vary; verification preserves the transmitted order.

The signature base follows RFC 9421 section 2.5: one quoted component identifier,
colon-space and value per line, followed by the `"@signature-params"` line with
the serialized inner list and its parameters. Join with LF, without a final LF.
Use the uppercase `GET` method, the full externally addressed target URI, and
the actual Authorization field value. Sign the resulting bytes directly with
Ed25519; do not hash them into a COSE envelope or use a COSE numeric algorithm ID.

The target includes scheme, authority (including non-default port), complete
body/attachment path and any query. Queries are prohibited by this retrieval
profile. A proxy deployment MUST reconstruct the external target using a pinned
provider origin and the preserved operation path, not untrusted forwarded
headers. A signature for a body cannot authorize an attachment, a different
attachment, host, port, method, token or provider endpoint. Redirects remain
prohibited. HTTPS remains mandatory outside isolated test fixtures.

## Freshness and replay

`created` is a nonnegative Unix timestamp in whole seconds. `expires` MUST equal
`created + 60`. Verifiers compare whole-second current time and allow 30 seconds
of clock skew: reject `created > now + 30` and `now > expires + 30`.
`nonce` is exactly 32 cryptographically random bytes encoded in canonical,
unpadded base64url (43 characters). A signer generates a new nonce for every
request, including each attachment and every retry.

After cryptographic verification, atomically consume `(recipient DID, nonce)`
across the entire serving provider, independently of token, path and key version.
Only one concurrent request may consume it. Retain it through `expires + 30`
inclusive. The replay store MUST survive process restarts and be shared by all
workers that serve the same origin. Do not cache successful verification for a
repeated request. Replay-store failure is a concealed authorization failure.
The reference provider uses PostgreSQL migration 0111, with indexed expiry and
bounded cleanup; rollback refuses to discard unexpired nonces.

A consumed nonce remains consumed even if subsequent storage or transport fails.
Retry with a fresh signature and nonce. Refresh local signing authority for each
attempt; do not persist signed HTTP headers in delivery queues or transfer data.
Authentication still does not override token revocation, expiry or source fences;
the repository checks those again before returning bytes.

## Concealment and resource limits

Missing/malformed/unknown/expired tokens, wrong recipient/key, missing/malformed/
expired signatures, replay, failed DID resolution and pre-authorization storage
errors share the uniform `404` problem response. Do not disclose content presence,
fence state, negotiation details or `503` storage failures until both proofs pass.
Unsupported content negotiation is `406` only after successful authentication.

The reference schedule admits at most 32 requests and eight per source during a
10-second fixed admission lease, independent of lookup outcome. All admitted
responses wait 750 ms; work not completed in that window yields the same generic
`404`. Outstanding work remains bounded and receives cancellation at 10 seconds;
work ignoring cancellation occupies a separate bounded processing gate. This
prevents lookup duration from selecting a different failure-response schedule.
Authenticated success/storage responses may finish within that window; clients
must tolerate a concealed response during slow verification. HTTP methods other
than GET receive public `405`, independent of resource existence.

The reference provider also limits ingress to 120 requests/minute/source and
verification attempts to 30/minute/token hash. Token-limited attempts use the
same concealed `404`. Only source/service-wide admission limits independent of
token validity can emit pre-authentication `429`. Signature-Input is bounded to
1024 characters and Signature to 128 before parsing; existing path, digest,
body-size and attachment-size limits remain in force.

## Retry, rotation and migration

A uniform `404` is not proof of permanent authorization failure. Refresh the
sender DID once per attempt and retry immediately only at a changed authenticated
service endpoint. An unchanged endpoint or another `404` schedules ordinary
bounded delivery backoff (`body-temporarily-unavailable`) until the existing
effective delivery deadline, then `delivery-expired`. Each request is signed
again; never resend the previous headers. Preserve original token/digest and
availability limits. Never downgrade to token-only retrieval after any failure.

Recipient key rotation requires the current key on the next attempt. A moved
recipient must sign using its new provider's current, locally held messaging key;
source fencing prevents the old provider from originating new retrievals.
A moved sender retains its existing body authorizations under the transfer
contract, but retrieval signatures must cover the newly authenticated target.
Provider-local nonce rows are not account-history objects and are not exported.
They remain at the old origin until expiry; old-target signatures cannot be
replayed at a new origin. Replacing a database while retaining the SAME origin
requires preserving unexpired nonce state or refusing retrieval for at least
120 seconds before serving with an empty replay store.

## Conformance and cutover

[Request vector](vectors/retrieval-signature.json) fixes the exact base, public
key and signature using a public test key. Tests compare WebCrypto with Node's
independent Ed25519 implementation, reject profile variations and tampering, and
exercise durable atomic replay rejection, restart, key/origin changes and
concealed failures through the database and HTTP routes. Existing delivery and
attachment tests exercise signed outgoing requests.

This is an intentional alpha transport break. Deploy compatible recipient signers
and sender verifiers together across test deployments. Signed envelopes, tokens,
body bytes and account keys do not change. Old callers receive concealed failure;
no compatibility reader or bearer-only fallback is retained. Reverting to a
bearer-only binary weakens authorization and is not a supported security rollback.
