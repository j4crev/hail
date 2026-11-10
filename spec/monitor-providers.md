# Reference monitor provider registration and enrollment

This is the reference monitor's optional HTTPS service API, not Hail federation
or a new PLC authority. It supports multiple Hail providers with separate service
credentials. Generic public DID subscriptions, provider transfer of monitoring,
and self-service replacement of an existing provider registration remain outside
this version. Same-operator monitoring retains its reduced-assurance label.

## Self-service registration v1

The public verification document has a [JSON schema](schemas/monitor-provider-registration-v1.json)
and a [fixed hash/field vector](vectors/monitor-provider-registration.json).

`POST /api/v1/providers/register` accepts uncoded `application/json`, at most
4096 bytes, with exactly `providerOrigin`, `alertOrigin`, `registrationSecret`,
and `expiresAt`. Origins are canonical HTTPS DNS origins on port 443 without
paths, credentials, queries or fragments. The private registration secret is a
random 32-byte unpadded base64url string (43 characters). `expiresAt` is an integer
Unix timestamp, in the future and no more than one hour ahead.

The provider operator publishes the same JSON document at
`/.well-known/hail-monitor-registration` on **both** origins:

```json
{
  "type": "hail.monitor-provider-registration",
  "version": 1,
  "monitorApiOrigin": "https://enroll.monitor.example",
  "providerOrigin": "https://svr.provider.example",
  "alertOrigin": "https://alerts.provider.example",
  "registrationHash": "SHA256_OF_PRIVATE_REGISTRATION_SECRET_AS_BASE64URL",
  "expiresAt": 2000000000
}
```

`registrationHash` is unpadded base64url SHA-256 of the UTF-8 secret string, not
its decoded bytes. The monitor injects its configured public API origin; callers
cannot select a different monitor. Documents must match these exact fields and
values, without extra fields or duplicate JSON keys. The monitor fetches a direct
`200` from each origin, validates public-only DNS results, pins the connection to
a validated address while preserving TLS hostname verification, rejects redirects,
and bounds DNS, response time and response size. The registration secret is never
sent to either verification-document endpoint. Publishing only its hash prevents a
reader of the public document from exchanging that document for a credential.

Success returns `200` with `providerId` (UUID), `providerOrigin`, `alertOrigin`,
`token` (43-character private service credential), `apiOrigin`, `monitorOrigin`,
`monitorPublicKey` (Ed25519 did:key), and `limits` containing `requestsPerMinute`,
`activeIdentities`, `enrollmentsPerDay`. The API and identity origins may differ.
The provider pins both monitor identity origin and signing key in its existing
onboarding policy. Registration responses and requests must never be logged or
cached. Credential files must be private; no credential goes to a DID user's browser.

Reference credential issuance uses SHA-256 of a monitor Ed25519 signature over
`hail.monitor-provider-credential.v1\0` followed by UTF-8 JSON encoding of the
array `[apiOrigin, providerOrigin, alertOrigin, registrationHash]`, then base64url.
This private derivation permits exact retries without storing a plaintext service
credential. It is not a publicly verifiable proof or a client signature format.
Only the token hash is retained. Exact retries of an enabled, unchanged registration
return the same credential after rechecking origin control. Conflicting registration,
disabled credentials, or an old registration after credential rotation fail closed;
registration cannot resurrect them. Operator rotation/revocation is scoped to one
provider and never silently stops its existing polling or alert delivery.

Invalid input is `400`, excessive body `413`, unsupported encoding/type `415`,
failed origin proof or conflicting registration `409`, capacity/rate refusal `429`,
and unavailable service `503`. `429` includes `Retry-After`. Errors contain no
credential or private configuration. Bodies have an overall read deadline.

## Managed enrollment authorization

Existing `/api/v1/onboarding` and `/api/v1/onboarding/stop` request bodies and
onboarding attestation formats remain unchanged. A bearer credential selects one
enabled provider registration. That registration fixes the accepted genesis service
origin and the consumer binding/alert receiver; requests cannot supply replacements.
The monitor retains enrollment ownership independently of the current PLC service
endpoint. A provider cannot adopt an existing manual enrollment, change another
provider's destination, or stop another provider's monitoring, even when it knows
the DID, genesis CID or receiver URL. A service-origin change is not a transfer of
this authorization. Stop leaves its existing tombstone and evidence intact.

The existing owner-signed exact Hail genesis checks remain mandatory. Before
enrollment, the provider binds the user's verified security email to the exact
signup/DID/CID; the monitor independently requests confirmation from the registered
receiver using its purpose-separated signed binding request. A caller's assertion
that email is verified is insufficient. Only after valid PLC evidence, healthy
polling and successful enrollment-notification delivery may onboarding attestations
be issued. A provider registration is neither user-email verification nor DID-owner
proof. Incident recovery still requires the separately owner-signed PLC operation.

## Reference admission policy

These are initial deployment limits, not protocol promises: per provider, 60
authenticated requests per minute (persisted in PostgreSQL), 100 active identities,
and 20 new identities per rolling day. Ownership and identity quota checks are
serialized with insertion; exact retries do not consume new-identity capacity.
Public admission stops at 100 registered providers or 1000 active identities.
Manual operator enrollment is outside public admission and must respect capacity.

The single reference process additionally bounds unauthenticated enrollment traffic
to 600 requests/minute, four concurrent enrollment requests and one per provider;
registration to 20 requests/minute and two concurrent requests. Source limits are
120 enrollment requests/minute and five registration attempts/minute. IPv6 sources
are grouped by /64; the source-counter map is bounded. These secondary counters
reset on restart; a multi-replica deployment needs shared edge limits. Trusted proxy
headers may be used only on an isolated backend with header overwrite at ingress.
Missing or malformed source addresses share the restrictive unknown-source bucket.

Rate/capacity refusal does not remove existing coverage. Credential revocation and
provider enrollment disablement do not stop polling, revoke incident access or
discard alerts. Operator actions, existing polling backpressure and notification
retry behavior remain separate from new-provider admission.

## Migration and verification

Migration 9 adds provider registrations and nullable enrollment ownership without
rewriting checkpoints, signatures, observations or notifications. An explicit
operator import hashes the previous secret and attaches only reviewed enrollments
matching the old provider and consumer receiver; ordinary public registration
cannot claim those rows. Independently/manual-enrolled rows remain unowned.
Retain backups and old configuration for application rollback. Do not delete the
new ownership tables as an ordinary rollback; old software cannot serve newly
registered providers. The public worker rejects obsolete single-provider settings.

Conformance coverage: `provider-registration.integration.test.ts` checks proof on
both origins, public-proof theft, exact retries, expiry and revocation;
`providers.integration.test.ts` checks hashed credential rotation, independent
limits, concurrent quota admission, ownership and preserved monitoring;
`signup-monitor.integration.test.ts` verifies the existing end-to-end email binding,
notification and attestation requirements with registered provider credentials.
