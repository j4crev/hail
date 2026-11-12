# Provider Service Accounts v1

Status: Current alpha reference-provider profile. Identifier `hail-provider-service-v1`.
This is a reference-provider custody profile, not a new Hail wire object, COSE
algorithm or PLC operation format. Peers see an ordinary DID, Address Binding and
Hail service; nothing in federation depends on this profile.

## Purpose and scope

A provider needs addresses that belong to the *provider*, not to a person:
`admin@`, `email@` (the email bridge sender), `abuse@`, `security@`, `support@`,
`ops@` and `alerts@`. Today those reserved names can only be claimed by a person
through owner-controlled or managed onboarding, which needs an owner recovery key,
email verification, monitor enrollment and a console-only role authorization.

A provider service account is an account whose every key is held by the provider
that serves it. It exists so a provider can be turned up and operated without a
person's custody ceremony. It is deliberately narrow:

- Only the provider's own reserved local parts on its native address domain.
- Never a person's account, and never an alternative to portable or managed
  custody for users. Actor type does not select this profile; the address does.
- Bound to its provider: it never transfers and never changes custody.

The [onboarding profile](account-onboarding.md) still applies to every user
account. [Managed custody](managed-custody.md) still requires an owner-held top
recovery key. The [custodial POC profile](account-onboarding.md#custodial-poc-profile)
remains a private-PLC test profile; this profile registers on the canonical public
PLC directory and is a production profile for provider-owned identities only.

## Authority

| Role | Custodian | Authority |
| --- | --- | --- |
| Highest-priority PLC recovery | Provider operator, offline | Recover the DID if the provider host or its key-encryption key is lost or compromised |
| PLC rotation | Provider host | Routine PLC updates |
| `#hail-identity` | Provider host | Grants and Address Bindings |
| `#hail-messaging` | Provider host | Envelopes, replies, Sender Profiles and delivery status |

Keys are generated independently per DID and role on the provider host, encrypted
under `KEY_ENCRYPTION_KEY` like managed keys, and never exported. Hail keys are
distinct Ed25519 keys; PLC rotation keys use P-256 or secp256k1.

One **provider recovery key** (P-256 or secp256k1) is shared by all of a
provider's service accounts. It is generated once, at provider installation, and
its private key is shown once for offline storage; the provider host retains only
the public key. It is listed first in every service DID's rotation keys. The
provider MUST refuse to create service accounts until it is recorded, and MUST
NOT change or remove it afterwards, because existing DIDs depend on it.

The provider and its operator are the owner. There is no third party to protect,
so no owner consent ceremony, owner backup verification or per-account monitor
enrollment applies. The provider MUST label these accounts as provider-held in
its account API and operator UI, and MUST NOT describe them as portable,
managed or independently monitored.

## Creation

1. **Eligibility.** The canonical address MUST be `{local}@{native-address-domain}`
   where `{local}` is in the provider's reserved-name set. Hosted custom domains
   are refused. An existing account, pending signup reservation or transfer
   reservation for the address refuses creation; it is never replaced.
2. **Keys and genesis.** Generate rotation, identity and messaging keys. Build a
   regular `plc_operation` with `prev: null`, rotation keys ordered
   `[provider-recovery, provider-rotation]`, the two Hail
   verification methods, one `HailMessaging` service at the provider's service
   base and empty `alsoKnownAs`. The provider rotation key signs it.
3. **Registration.** Derive DID/CID, retain the exact operation before
   submission, submit only to `https://plc.directory`, and reconcile ambiguous
   writes against the same retained bytes, as in normal onboarding. Never create
   disposable public identities as tests.
4. **Binding and activation.** Sign a version-2 Address Binding with the identity
   key, host it, and verify it through public DNS/WebFinger discovery exactly as
   for any account. Activate with `activation_verification_mode = public` and
   record service-account evidence: profile identifier, provider identity and
   provider-recovery public keys, and creation time.
5. **Retries.** Creation is idempotent per address: a retry resumes the retained
   preparation and never generates new keys after the operation was retained.

Activation requires the provider's public origin and DNS to be live, so the
installer creates service accounts only after HTTPS readiness succeeds. The
installer creates `admin@`, and `email@` when the email bridge is enabled. An
operator creates other reserved names on demand.

## Access

Service accounts have no recovery secret and no account-access recovery through
owner proof. Login is by passkey only:

- An operator with host access issues a single-use passkey enrollment link for a
  named service account (reference: `hailctl admin passkey-link admin`). It uses
  the existing enrollment capability: one use, at most ten minutes, bound to the
  account and its serving generation. Host access already implies full control
  of the provider, so this grants no new authority.
- `admin@` is granted provider-operator access when its first passkey is
  enrolled. Other service accounts receive no operator access implicitly.
- v1 enrolls passkeys only for `admin@`. The provider drives other service
  accounts (for example the email bridge sends as `email@`). Reading mail sent to
  other service accounts is deferred until Hail defines an inbound path for
  people who are not yet connected (unsolicited contact is currently undefined).
- v1 service accounts do not use the reference client's provider-signed Grant
  management; `admin@` is an operator login.

## Restrictions

The provider MUST refuse, before any signing or state change:

- Transfer grants, Offers or fences naming a service account (no owner exists to
  authorize them), and acceptance of an incoming transfer into a reserved name.
- Same-provider custody transitions to or from this profile.
- Signup, invitation, custom-domain or transfer reservation of a reserved name by
  anyone other than this creation path.

A database guard admits a reserved local part on the native domain only through
a claim recorded by the creation path. Claims made under the earlier pre-launch
owner-key role flow remain valid for accounts that already hold them; that flow
no longer exists.

## Lifecycle

Closing a service account follows ordinary account closure: withdraw WebFinger and
binding publication, retain evidence, wait the reassignment interval before the
address can be recreated at a new DID. Recreating a closed service account
creates a new DID. Loss of `KEY_ENCRYPTION_KEY` loses routine control; recovery
then requires the provider recovery key or a new DID. The reference provider does
not yet include tooling that signs a recovery operation with that key.

## Reference implementation

- Migration 0126: the immutable `provider_service_recovery` key, retained
  preparations, `provider_service_account_evidence`, owner-less role claims, and
  triggers that refuse transfer authorizations, fences and custody transitions
  for service DIDs.
- Server CLI `src/cli/service-account.ts` (`bun run account:service`):
  `recovery-key show|set <did:key>|generate`, `create <name>`, `list` and
  `passkey-link admin`. `hailctl` wraps these.
- Operator API `GET/POST /api/v1/operator/service-accounts` and the `/admin`
  page list service accounts and create one for an unused reserved name, with a
  passkey login in the last ten minutes. Passkey links stay host-only in v1.
- Enrolling a passkey for `admin@` through a host-issued link grants provider
  operator access.
- Account API `custodyProfile: "provider-service"`.
- Sender Profiles for service accounts (the email bridge's `email` category)
  are created on the host with `bun run profile:create`.

## Conformance cases

| ID | Positive case | Required refusal |
| --- | --- | --- |
| PS-01 | Create `admin@` on the native domain end to end | Non-reserved local part, custom domain, occupied or reserved-by-signup address |
| PS-02 | Exact genesis with provider-only keys, canonical PLC read-back | Changed retained operation on retry, private registry as public proof |
| PS-03 | Binding verified by public discovery before activation | Unverified publication, mismatched keys or service |
| PS-04 | Host-issued passkey link enrolls once; `admin@` gains operator access | Expired, reused or other-account link; operator grant for non-admin |
| PS-05 | Provider drives `email@` as bridge sender | — |
| PS-06 | — | Transfer, custody transition, or signup claim of any service account |
| PS-07 | Retry after crash resumes the same DID | New keys after operation retention |

## Unresolved interoperability decisions

- Whether peers should be able to learn that an address is provider-held (for
  example through Sender Profile metadata). v1 adds nothing to the wire.
- Recovery tooling and procedure for signing a PLC operation with the offline
  provider recovery key.
