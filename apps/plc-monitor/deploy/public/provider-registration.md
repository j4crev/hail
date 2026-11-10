# Register a provider with a shared PLC monitor

Registration is self-service. No monitor SSH account or IP allowlist is required.
You need control of the provider API HTTPS origin and an alert receiver implementing
the [verified consumer binding contract](../../../../spec/alpha-onboarding.md).
A separate receiver per provider is the simplest setup; sharing a receiver does not
give providers permission to overwrite each other's bindings. The receiver must
pin this monitor's signing key before accepting its signed binding queries/alerts.

## Register

From this repository, with Bun and workspace dependencies installed:

```bash
umask 077
bun run --cwd apps/plc-monitor monitor:register-provider prepare \
  https://enroll.monitor.example https://svr.provider.example https://alerts.provider.example \
  /absolute/private/registration.json /absolute/path/verification.json
```

Publish **only `verification.json`**, unchanged, at both URLs printed by the command:
`https://svr.provider.example/.well-known/hail-monitor-registration` and
`https://alerts.provider.example/.well-known/hail-monitor-registration`.
Serve a direct HTTPS `200` response, without redirects, authentication, browser
challenges or caching. Use your existing reverse proxy, static hosting, or receiver
router; do not expose a new plaintext application port. A Caddy HTTPS site can use
a specific `handle /.well-known/hail-monitor-registration` with `rewrite` to the
file and a `file_server` rooted in a directory containing only that public file.
Place it before the catch-all reverse proxy. Never serve the private directory.

Both endpoints opt in to the exact monitor API, provider and receiver combination.
The public document contains a hash of the private registration secret; that hash
is not sufficient to obtain a credential. Documents expire after one hour. If the
window expires before completion, prepare a new pair of files and replace both
public documents. Credentials already issued must be managed rather than registered
under another secret.

```bash
bun run --cwd apps/plc-monitor monitor:register-provider finish \
  /absolute/private/registration.json /absolute/private/monitor-credential.json
```

The credential file is created mode `0600` and is never printed. If the response is
lost, repeat `finish` with the **same** private registration file and a new output
filename while the proof remains valid. It returns the same credential. Remove both
public verification documents after success. Keep the private credential securely;
do not put it in a browser, URL, issue, repository, or access log.

Map the returned values into the provider's protected configuration:

| Provider setting | Registration result |
| --- | --- |
| `SIGNUP_MONITOR_API_ORIGIN` | `apiOrigin` |
| `SIGNUP_MONITOR_TOKEN` | `token` |
| `SIGNUP_MONITOR_PUBLIC_KEY` | `monitorPublicKey` |
| `ALPHA_SIGNUP_MONITOR_ORIGIN` | `monitorOrigin` |

The monitor identity origin can differ from the API hostname. Pin its returned
public key in the alert receiver as well. Retain the provider's signup-email service
credential; it is separate from the monitor credential. Follow the provider's normal
configuration rollout, then test unauthenticated `401` and authenticated invalid-body
`400` from the provider, without creating a real identity as a probe.

Registration proves administrative control of the two HTTPS endpoints. It does not
verify the security email of any DID user, establish independence from the provider,
or grant the provider authority to approve PLC changes. Users still complete the
existing email-code ceremony; the monitor independently checks each binding and
waits for delivered enrollment notification before issuing an attestation.

## Limits and management

Initial reference-policy limits: 60 authenticated requests/minute, 100 active
identities and 20 new identities per rolling 24 hours per provider. Exact successful
enrollment retries do not consume new-identity quota. The service initially admits
at most 100 providers and 1,000 active identities across public enrollment. Capacity
refusal pauses admissions; it never silently stops existing monitoring.

The monitor operator can inspect, rotate or disable credentials using the existing
privileged administration path:

```bash
bun run monitor:providers list
bun run monitor:providers rotate PROVIDER_UUID /private/new-credential.json
bun run monitor:providers disable PROVIDER_UUID
bun run monitor:providers enable PROVIDER_UUID
```

Rotation invalidates the old credential; coordinate provider configuration. Disabled
credentials cannot be revived through registration retries. Polling and alerts for
existing identities continue. Self-service credential recovery/rotation and provider
transfers are not implemented by registration; contact the operator if the issued
credential is lost or the provider/receiver origin must change. Do not share another
provider's credential or transfer ownership by editing a request origin.
