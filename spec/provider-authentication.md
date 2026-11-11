# Provider authentication and enterprise integration

Status: provider-local integration contract for the reference server; not a
federation requirement, OAuth authorization server, or OIDC/SAML wire profile.
Providers choose authentication. A provider can reuse its existing email login,
including enterprise SSO, without enrolling an additional Hail passkey. Haili's
built-in login and reference GUI remain passkey-based.

## Authority boundaries

1. **Account authentication** establishes the identity and current organizational
   access of a user through a provider-approved backend.
2. **Client/API authorization** binds that identity to a local Hail account,
   serving generation, session lifetime and permitted operations.
3. **Independent owner/recovery authority** remains defined by the custody,
   onboarding and transfer specifications. Login, organizational administrator
   roles, MFA and recent reauthentication MUST NOT substitute for required owner
   signatures or exact-action approvals.

Identity-provider roles do not grant Hail provider administrator roles. Existing
passkey-only actions are reference-provider policy; this integration does not
convert an enterprise session into a passkey session or weaken those checks.

## Trusted backend boundary

`ProviderAuthenticationIntegration` is a server-side interface, installed by the
provider operator in trusted code. `login(proof)` verifies an existing application
session; `checkSession(sessionId)` revalidates that session and organizational
access on every Hail authentication. Both return a verified identity or null;
backend failure must fail closed. Implementations must bound upstream request
duration and must not cache authorization beyond their documented revocation
latency. The reference boundary itself does not cache upstream results.

The returned identity contains issuer, tenant, stable subject, a non-secret
upstream session reference, authenticated-at and expiry timestamps, and an
explicit active flag. The subject is not an email address lookup. The session
reference must identify one immutable authenticated identity, not a directory
user whose login is presumed to remain valid indefinitely.

The backend owns OIDC/SAML protocol validation, including trusted keys,
issuer/audience, signature, expiry, redirect binding, nonce/state and replay
protection as applicable. It must complete that validation before returning an
identity. Raw claims, ID tokens or user-supplied identity headers MUST NOT be
passed through as verified identities. LDAP/AD access belongs behind this backend
or its identity broker, never in a Hail browser client.

No production OIDC, SAML or LDAP connector is supplied by this change. The
integration test models an existing application's already-verified SSO session;
it does not establish OIDC/SAML protocol conformance.

## Trust, provisioning and account binding

The operator configures integrations with explicit allowed issuer/tenant pairs.
The server snapshots those pairs at construction. Removing an integration or
its authority from configuration rejects its sessions after that configuration
is loaded. Wildcard trust and discovery based on untrusted login input are not
supported.

Administrative `bind` explicitly maps `(integration, issuer, tenant, subject)` to
an already-active account and its current serving generation. Provisioning uses
the existing account onboarding process first; login does not create an account,
change custody, infer an organization from email, or auto-link accounts. A binding
cannot be reassigned through this interface, including after disablement. There
is no public binding endpoint. The host application must authorize provisioning
administration independently from user login.

Binding and session records are provider-local and are not copied by account
transfer. A generation change invalidates prior bindings and sessions. A return
or recovery requiring rebinding needs an explicit administrative process with
independent account-authority checks; automated rebinding is not implemented.
Directory access recovery alone does not recover Hail ownership keys.

## Session and API behavior

After the host application validates its login flow (including CSRF protection),
it calls `ProviderAuthentication.login`. The service issues a fresh random
`hailps_` session token, stores only its hash, and records the verified upstream
session reference. The token carries no user claims. It is accepted only as the
`hail_session` cookie by the reference account API, never as an API bearer.
The host must set it in a Secure, HttpOnly, SameSite=Lax cookie with Path=/ and
an expiry no later than the returned deadline, over HTTPS. It must revoke an
old Hail session when replacing it. Tokens/proofs must not be logged or exposed
in URLs. The host owns its login and reauthentication UI and endpoints.

Construct `AccountApiRepository(sql, policy, providerAuthentication)` to opt in;
the default server construction continues to support only its existing login.
Both passkey and integrated sessions pass through the same account repository
and API scope checks. Existing origin/CSRF protections apply to cookie writes.
An invalid Authorization header does not fall back to cookie authentication.

The initial integration permits explicit per-binding subsets of `account:read`,
`grants:read`, `messages:read`, and `messages:write`. Upstream role/scope claims
cannot expand this set. In particular, integrated sessions cannot mint independent
API credentials that would escape organizational revocation. Account writes,
owner actions, Grant signing approvals and passkey-only GUI operations are not
added by this profile. Providers wanting those operations need a separately
specified authorization/approval path; a recent SSO login alone is insufficient.
The shared CLI code exchange and OAuth client access are not extended here.

## Reauthentication, logout and offboarding

Default idle/absolute limits are 30 minutes/12 hours, bounded further by the
upstream expiry and original authentication time. Constructor policy can shorten
or lengthen these within its validated bounds. Activity updates idle time but
never extends absolute expiry. An upstream expiry reduction shortens the local
session; an upstream extension never extends it. Future authentication times,
expired assertions, changed subject/issuer/tenant/session reference or changed
authentication time reject the old session.

Reauthentication requires a new verified login and a new local token; the host
revokes the previous token. Reauthentication does not grant additional scopes or
owner authority. The common session exposes authentication method and time for
provider policy, without manufacturing passkey verification evidence.

Local `revoke(token)` and the reference logout endpoint permanently revoke that
Hail session. Logout does not necessarily log the user out of the organization's
other applications. `disable(bindingId)` permanently disables that local binding.
The adapter must also reject revoked upstream sessions and removed/disabled
organization members. Upstream logout/offboarding is effective on the next Hail
request after the backend observes it; backend event delivery/polling latency
must be documented by a production integration. Hail adds no authorization cache.

The database rechecks local revocation, disablement, account closure, expiry and
generation after upstream verification. Local changes committed before that
check reject the request. Already-admitted requests can complete; this is not
transactional cancellation across the external directory and Hail. Long-lived
operations must use their existing reauthorization boundaries. Session/identity
records retain revocation and binding history; rollback refuses to discard them.

## Conformance evidence and remaining integration work

`apps/server/test/provider-authentication.integration.test.ts` exercises the
real database and HTTP account API with a trusted existing-session test adapter:

| Case | Required outcome |
| --- | --- |
| Existing SSO session, explicitly bound active account, no passkeys | Account API succeeds within binding scopes |
| Unknown integration, forged proof, unapproved issuer, wrong tenant, different subject | Login/session rejected |
| Rebind an identity to another account, including after disablement | Rejected |
| Upstream roles/scopes or database policy attempt credential/owner scope escalation | No expanded authority |
| Login-only custody/credential requests | Rejected |
| Cross-origin write or malformed Authorization with a valid cookie | Rejected |
| Local logout, disabled binding or upstream session removal | Next authentication rejected |
| Upstream unavailable | Fail closed; HTTP service unavailable |
| Disable committed during upstream validation | Rejected at local recheck |
| Idle/absolute expiry, closed account or changed serving generation | Rejected |
| Reauthentication changes authentication time | Old token rejected; new login required |
| Rollback with identity history | Refused without deleting history |

The existing passkey integration suites prove the built-in method remains usable.
Production connector selection, actual OIDC/SAML validation and lifecycle event
integration, generic GUI action approvals, and any shared OAuth client-access
profile remain separate work. No corresponding discovery capability is advertised.
