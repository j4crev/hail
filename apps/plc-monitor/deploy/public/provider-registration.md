# Register a provider with the shared PLC monitor

Registration is self-service and follows [registration v2](../../../../spec/monitor-receiver.md).
You need control of your provider's API origin (and its web origin, if you run the
reference web client) and an email address for operator notices. You do **not**
run an email or alert service: the shared receiver verifies your users' security
emails and delivers their alerts. `hailctl` performs these steps for you; this is
the manual equivalent.

## 1. Prepare

From this repository, with Bun and workspace dependencies installed:

```bash
umask 077
bun run --cwd apps/plc-monitor monitor:register-provider prepare \
  https://enroll.monitor.example https://svr.provider.example https://provider.example ops@provider.example \
  /absolute/private/registration.json /absolute/path/hail-monitor-registration.json
```

Pass `-` instead of the web origin for a server-only provider. Publish **only**
the public file, unchanged, at every URL the command prints
(`/.well-known/hail-monitor-registration` on each origin). With the
[standalone deployment](../../../server/deploy/standalone/README.md), copy it into the
deployment's `registration/` directory; its Caddy serves exactly that file on both
hostnames and nothing else from the directory. Otherwise serve a direct HTTPS
`200`, without redirects, authentication, browser challenges or caching.

The public document contains a hash of the private registration secret; it is not
enough to obtain credentials. Documents expire after one hour. If time runs out,
prepare a new pair of files.

## 2. Request the operator code

```bash
bun run --cwd apps/plc-monitor monitor:register-provider request /absolute/private/registration.json
```

The monitor checks every published document, then emails an eight-digit code to
your operator address. It is valid for ten minutes and five attempts. Repeating
`request` does not send another email; add `--resend` for a new code (one-minute
cooldown).

## 3. Finish

```bash
bun run --cwd apps/plc-monitor monitor:register-provider finish \
  /absolute/private/registration.json 12345678 /absolute/private/monitor-credential.json
```

The credential file is created mode `0600` and is never printed. If the response is
lost, repeat `finish` with the same private file and code, to a new output
filename; it returns the same credentials. Then delete the published document(s).

Map the result into the provider's protected configuration:

| Provider setting | Registration result |
| --- | --- |
| `SIGNUP_MONITOR_API_ORIGIN` | `apiOrigin` |
| `SIGNUP_MONITOR_TOKEN` | `token` |
| `SIGNUP_MONITOR_PUBLIC_KEY` | `monitorPublicKey` |
| `ALPHA_SIGNUP_MONITOR_ORIGIN` | `monitorOrigin` |
| `SIGNUP_EMAIL_ORIGIN` | `receiverOrigin` |
| `SIGNUP_EMAIL_TOKEN` | `receiverToken` |

Follow the provider's normal configuration rollout. Test unauthenticated `401` and
authenticated invalid-body `400` from the provider, without creating a real
identity as a probe.

Registration proves control of the declared origins and the operator mailbox. It
does not verify any user's security email, establish independence from the
provider, or grant the provider authority to approve PLC changes. Users still
complete the email-code ceremony during signup.

## Limits and management

Initial reference-policy limits: 60 authenticated requests/minute, 100 active
identities and 20 new identities per rolling 24 hours per provider; 100 signup
emails per hour per provider at the receiver. Exact successful enrollment retries
do not consume new-identity quota. The service admits at most 100 providers and
1,000 active identities across public enrollment. Capacity refusal pauses
admissions; it never silently stops existing monitoring.

The monitor operator manages credentials through the existing privileged path.
Commands that change the receiver need `MONITOR_PRIVATE_KEY_FILE` and
`MONITOR_RECEIVER_ORIGIN`:

```bash
bun run monitor:providers list
bun run monitor:providers rotate PROVIDER_UUID /private/new-credential.json
bun run monitor:providers rotate-receiver PROVIDER_UUID /private/new-receiver-credential.json
bun run monitor:providers disable PROVIDER_UUID
bun run monitor:providers enable PROVIDER_UUID
bun run monitor:providers provision PROVIDER_UUID
```

Disabling, enabling and retiring a provider re-provision it at the receiver.
Rotation invalidates the old credential; coordinate provider configuration.
Disabled credentials cannot be revived through registration retries. Polling and
alerts for existing identities continue. Contact the operator if a credential is
lost or the provider origin must change.

### Migrating a provider registered before v2

A provider registered under v1 keeps its monitor credential. Give the shared
receiver its existing receiver secret (the provider's current `SIGNUP_EMAIL_TOKEN`)
so its configuration does not change:

```bash
bun run monitor:providers receiver-import PROVIDER_UUID /private/receiver-secret.txt https://provider.example
```

Only the secret's hash is stored. Use `-` for a provider without a web origin.
