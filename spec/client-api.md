# RACR client interoperability profile — account API v1

This is an optional client-to-provider profile, not a federation requirement.
Independent providers may implement it to support the `racr` CLI. A provider can
federate without implementing this API. `racr.*` names designate shared client
formats here, not a particular provider implementation or database schema.
The CLI's terminal output contract v2 is separately versioned.

## Authentication boundary

Providers choose their own user authentication: passkeys, passwords, enterprise
SSO or another mechanism. The CLI MUST NOT require a WebAuthn assertion or a
provider session cookie. Browser login delegates authentication and permission
review to a provider-hosted page. The reference web application continues to
require passkeys; using that web application requires its additional browser
session, enrollment and exact-action approval APIs. Implementing this CLI profile
alone does not establish web-client compatibility.

This profile specifies the existing RACR browser exchange with SHA-256 PKCE.
It is **not OAuth or OpenID Connect**. OAuth discovery, arbitrary API base paths,
headless device authorization and dynamic client registration are not defined.
A provider may use an external identity service behind its authorization page,
but credentials and exchange requests remain bound to the selected provider.

## Provider selection and transport

The user explicitly selects a canonical HTTPS DNS origin for login. Credential
files bind that origin and an account UUID. Account commands MUST use the bound
origin; `--provider` and `--account-id` are assertions, not overrides. A provider
transfer does not forward the old credential to the new provider.

Account operations use `/api/v1/account`; capabilities use
`GET /api/v1/capabilities`. Requests carrying account access use
`Authorization: Bearer <token>`. Clients MUST reject HTTP redirects for API calls,
verify TLS, bound response sizes and keep secrets out of terminal output.
Responses use `Content-Type: application/json`, without Content-Encoding or
Location. Authorization responses are bounded at 64 KiB. The operation-specific
larger bounds are listed in the [CLI contract](../apps/cli/docs/cli-contract.md).

## Browser authorization

1. The CLI binds a loopback listener at `http://127.0.0.1:PORT/callback`, with
   PORT at least 1024. It generates independent cryptographically random 32-byte
   state, code, verifier and credential token values. Base64url encoding is
   unpadded; code has prefix `hailc_`, credential token has prefix `racr_`.
   It privately persists all retry state before submitting anything.
2. `POST /api/v1/auth/authorization/prepare` takes exactly:
   `clientId`, `redirectUri`, `state`, `code`, `codeChallenge`, `scopes`.
   `clientId` is `racr-cli-v1`; `codeChallenge` is unpadded base64url SHA-256 of
   the verifier's UTF-8 bytes. The browser-login scope set is a nonempty subset
   of `account:read`, `grants:read`, `messages:read`, `messages:write`.
   No bearer credential or browser cookie accompanies the request.
3. Preparation returns `requestId` (UUID), `authorizationUrl`, and `expiresAt`
   (RFC 3339 timestamp). The authorization URL MUST use the selected provider's
   exact origin, without userinfo. Its path is provider-chosen. It contains one
   `request` query parameter matching the request ID, one `state` matching the
   request state, and exactly `code=<code>` in the fragment. Additional query
   parameters are provider-local. URLs are bounded at 8192 bytes. Duplicate
   `request` or `state` parameters are invalid. Codes MUST NOT be put in query
   strings. The CLI opens this URL in the system browser.
4. The provider authenticates the user, reviews the requested permissions and
   binds approval to the immutable request and selected account. The provider's
   browser interaction is implementation-defined; no `/passkeys` endpoint is
   required. The provider MUST protect its browser flow against CSRF, avoid
   leaking authorization fragments, and validate any external identity-service
   return before approving. Authorization expires within five minutes.
5. After approval, the provider sends the browser to the original loopback
   URI with exactly `state` and `code` query parameters. The CLI verifies both.
   The callback is only a signal to attempt exchange, not account authority.
6. `POST /api/v1/auth/authorization/token` takes exactly `clientId`,
   `redirectUri`, `code`, `verifier`, `token`. The last field is the CLI-generated
   credential token retained in private state. The provider MUST verify the
   original client, redirect, code, PKCE challenge, approval, expiry and current
   account authority before issuing scoped access. It MUST NOT issue access
   merely because the loopback callback happened.
7. The response is `racr.api-credential` version 1, with `provider`, `accountId`,
   `credentialId` (UUID), `token`, `scopes`, `expiresAt`. Origin, token and scope
   set MUST match the request. The CLI saves it in a private credential file.

Preparation retries with identical inputs MUST reuse the pending request;
conflicting inputs MUST NOT replace it. Identical exchanges within the original
validity window MUST return the same credential ID and expiry; changed token or
verifier MUST NOT mint replacement access. Providers MUST reject expired,
revoked, closed or migration-fenced authority. A database transaction is one
implementation strategy, not a required storage technology. Private CLI state is
valid for at most five minutes; retry with the same artifacts within that window.

## Account operations and optional workflows

`GET /api/v1/account` requires `account:read` and returns `racr.account` version 1:
provider origin, account UUID, DID, address, granted scopes, custody profile,
migration state and public key/monitor metadata. Custody and monitor fields
express actual authority; providers MUST NOT invent a managed custody attestation
to satisfy a client. Nullable metadata remains null when inapplicable. The
[account result contract](../apps/cli/docs/cli-contract.md#reference-account-api-v1)
and [endpoint inventory](../apps/server/README.md#racr-account-api) define the
current field shapes, scope requirements and requests for mailbox, submission,
credential, Grant and profile operations. These shared wire shapes are retained;
implementers do not need reference-provider SQL tables or migration numbers.

Implement the operations needed by the workflows offered to users. Missing
optional operations return 404/405; clients MUST NOT infer permission or invent
a fallback. Capabilities advertise optional features such as inbox waits,
connections and shared conversations. An advertised feature MUST implement its
whole documented operation contract. Implementing browser login and account
inspection alone is not a claim to implement messaging or account portability.

The same operation IDs, signed artifacts and immutable intent MUST survive
ambiguous submission retries. Local submission acceptance is distinct from
recipient delivery; status uses retained authenticated evidence. List cursors,
page limits, scopes, fence checks, key-role checks and custody-specific signature
requirements are specified in the linked operation contracts, not replaced by
successful login. Providers MUST NOT treat bearer access as an owner identity
signature or as approval to perform otherwise restricted managed signing.

Signup, owner-proof login, passkey recovery, custody changes and transfer are
separate workflows. Supporting ordinary browser login does not require these
APIs. `account login` is the explicit owner-proof command; `account browser-login`
is the authentication-method-neutral command. An existing-account user need not
create a new identity or use owner recovery keys to obtain ordinary CLI access.

## Capabilities and errors

`racr.capabilities` version 1 contains `features` and `signup` objects.
`signup.available` is a boolean and `signup.mode` describes provider policy
(`public`, `invite`, or null when inapplicable); unavailable signup is expressed
by `available: false`. Feature names and boolean
support values follow the endpoint inventory. Unknown additive fields are ignored.

Optional `interactionRequired` lists CLI action names requiring interactive
provider approval. `doctor --action` reports `INTERACTION_REQUIRED` for a listed
action. The existing optional `passkeyRequired` list expresses the narrower
policy of providers that require passkeys; it takes precedence for the same
action, avoiding duplicate blockers. These are diagnostic hints, not authority
or permission to start login automatically. Omission is not proof that an action
will succeed; the actual operation MUST enforce authorization.

Authenticated failures use Problem Details; clients rely on HTTP status and
known `Hail-Error-Code` values, not untrusted prose. In addition to existing
`CREDENTIAL_EXPIRED`/`CREDENTIAL_REVOKED` (401), `MISSING_SCOPE`/`PASSKEY_REQUIRED`
(403) and `APPROVAL_EXPIRED` (410), providers may return `INTERACTION_REQUIRED`
with 403. This means the requested action requires additional provider
interaction. It does not grant access, authorize scope escalation or trigger an
automatic browser launch. Unknown or status-mismatched codes fall back to the
HTTP status. Existing reference account-access/onboarding error shapes remain
specified by their separate contracts.

## Conformance evidence and limits

`apps/cli/tests/browser-cases.ts` runs the native CLI against an independent
HTTPS fixture using a custom `/company/sso/approve` page, without passkey routes
or reference-provider services, then uses the issued credential for account
inspection. It checks exact retry recovery, PKCE, scope acknowledgement,
provider origin, userinfo rejection, duplicate query parameters, invalid request
IDs, fragment binding and callback mismatch. The fixture simulates browser
approval; it does not certify any real SSO integration.
`apps/cli/tests/compatibility.ts` separately covers mailbox/account contracts,
provider/account selection, redirect refusal, bounded reads and neutral errors.

This profile does not yet provide a standalone complete conformance suite for
third-party providers; the linked per-operation contracts and CLI fixtures are
required implementation references. A future independently versioned discovery
or OAuth profile must define its own trust, registration and migration rules;
it must not silently reinterpret this exchange.

## Reference web-client caching (non-normative)

The reference GUI may retain bounded, session-scoped mailbox results in browser
memory and revalidate them using existing authenticated account operations. Its
`/mailbox-data` presentation endpoint is internal to the GUI, not part of this
client-to-provider profile. “Load older” is a presentation over existing cursors;
it introduces no snapshot, change token, hash, or incremental-sync guarantees.
Full message bodies remain available through existing account endpoints; the GUI
may project compact list summaries before transmitting them to its browser.
Provider authorization remains authoritative for every read and mutation. See
[web-client behavior](../apps/client/README.md#mailbox-cache-and-recent-history).

## Reference-provider browser media and origin separation

This section specifies the reference provider's optional browser extension, not
mandatory federation behavior. The account API origin, browser/passkey origin,
and native account domain are separate configuration roles. Account records and
CLI credential files identify the API origin. Native address domains differing
from the API hostname use the existing `_hail-provider` DNS delegation format;
this configuration does not grant authority over arbitrary custom domains.

The authorization URL returned to a CLI remains on the selected API origin.
That browser-only entry point may redirect to the configured browser origin,
preserving request/state and the browser-held code fragment. API clients still
reject redirects; the browser follows the navigation. Passkey RP ID and expected
origin remain the browser's configured values.

`POST /api/v1/account/media-ticket` accepts exactly a JSON object with `path`.
It requires normal account authentication, `messages:read`, and the usual
cookie/Origin CSRF check. The path is restricted to `/api/v1/account/senders/{did}/avatar/image` or
`/api/v1/account/attachments/{sender}/{messageId}/{digest}`, including an optional single attachment `index`
(0–19). The DID is canonical `did:plc` (colons may be percent-encoded); attachment
sender is a DID or `sent-message`, `sent-connections`, or `sent-category`, messageId
is a UUID, and digest is a 43-character unpadded base64url SHA-256 digest.
Arbitrary URLs, other API paths and extra query parameters are rejected.
Issuance does not assert that the resource exists; access is checked at redemption.
Malformed input returns 400, unsupported methods 405, and missing read scope 403.
The reference implementation limits the issuance body to 2048 bytes (413 otherwise).
The response is `{ "url": "https://PROVIDER/api/v1/media/TOKEN", "expiresIn": 60 }`.
TOKEN is an opaque, cryptographically random 32-byte unpadded base64url capability.
Neither session tokens nor API credentials appear in the URL or response.

`GET /api/v1/media/TOKEN` accepts no query parameters. A valid ticket can be reused
within its 60-second lifetime for its one bound resource only. Redemption repeats
normal authentication, scope, serving-generation and resource authorization;
revoked/expired sessions or lost access are not bypassed. Unknown/expired tickets
return 404; ordinary authentication/resource failures retain their normal status.
Successful responses retain the resource's fixed content type, `nosniff`, and
attachment download disposition where applicable, plus `Cache-Control: private,
no-store`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: sandbox;
default-src 'none'`. No session cookie is issued on redemption.

Reference policy bounds outstanding tickets to 4096 per provider process. Full
capacity returns 503; tickets are process-local and disappear on restart. This
implementation assumes one provider process; a replicated deployment needs a
shared bounded capability store or equivalent routing before enabling this
extension. Treat URLs as private bearer capabilities: redact them from access
logs/telemetry and never cache them at a CDN. Expiry does not revoke a download
already in progress. Tickets add no authority beyond the issuing account.

The browser origin must not proxy uploaded bytes. Its API bridge permits only
JSON responses and blocks the media-ticket, media-redemption, attachment-download
and avatar-image endpoints. Browser avatar/attachment routes return redirects to
provider capabilities, with no-store/no-referrer headers. Host-only application
cookies are never shared using a parent-domain cookie. CORS is not opened to the
media origin; server-to-server JSON bridging preserves the actual browser Origin
and incoming Authorization header, including scoped signup credentials. It must
not substitute a trusted Origin for a request supplied by another origin.

Conformance cases: an altered path/query cannot select another file; expiry,
revocation and scope loss deny redemption; media/HTML/SVG response bodies cannot
pass through the browser JSON bridge; provider-origin credential metadata is
independent of the passkey origin. Executable vectors live in
`apps/server/test/media-tickets.test.ts`, `apps/client/src/lib/media-origin.test.ts`,
and the built-client HTTP boundary test `apps/client/scripts/check-origin-separation.ts`.

Unresolved interoperability decision: the current provider-transfer profile ties
destination native domains to service hostnames and rejects delegated-domain
source addresses. Separating the native address domain does not relax those
checks or define a new transfer protocol. Such transfers remain unavailable until
that profile, schemas and conformance vectors are updated together.
