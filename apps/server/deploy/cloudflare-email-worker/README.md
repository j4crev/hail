# Cloudflare ingress adapter for the email bridge

This Worker receives mail for the email bridge's alias domain through
Cloudflare Email Routing and hands it to the provider through the
[ingress contract](../../../../spec/email-bridge.md#ingress-contract). It is one
deployment choice for haili.app; the provider has no Cloudflare-specific code.

It never sends email: no forwarding, replies or bounces.

## Behaviour

- Only mail for `ALIAS_DOMAIN` is considered; everything else is refused.
- Messages over `MAX_MESSAGE_BYTES` (10 MiB by default, the provider's limit)
  are refused before the body is read.
- The Worker asks the provider whether the recipient may receive mail, then
  submits the unmodified message.
- **Refusals are permanent.** A Worker cannot return a temporary SMTP failure,
  so a provider `defer` (a recipient over its limits) is refused rather than
  retried by the sender.
- **Outages are absorbed.** If the provider is unreachable or answers
  unexpectedly, the message is kept in R2 and retried from a queue at doubling
  intervals, capped at 12 hours, for 16 attempts (about five days). The
  provider decides again on each retry; mail it refuses after being held is
  discarded silently. A message still undelivered after the last attempt is
  deleted and logged.

## Setup for haili.app

Aliases need a domain of their own. Email Routing allows a catch-all rule only
on a zone's apex, so a subdomain of the Hail address domain cannot receive
arbitrary aliases. haili.app uses `haili.email`.

1. **Provider.** Set these and restart; the provider refuses to start with only
   some of them:

   ```sh
   EMAIL_BRIDGE_DOMAIN=haili.email
   EMAIL_BRIDGE_INTAKE_TOKEN=<32 random bytes, unpadded base64url, used for nothing else>
   EMAIL_BRIDGE_SENDER=email@haili.app
   ```

   `email@haili.app` must be an active account with a Sender Profile offering
   the `email` category. See the operator setup in the specification for the
   converter's database role and process.

2. **Storage and queue.** In the Cloudflare account:

   ```sh
   bunx wrangler r2 bucket create hail-email-bridge-pending
   bunx wrangler r2 bucket lifecycle add hail-email-bridge-pending expire-held --expire-days 7
   bunx wrangler queues create hail-email-bridge-retry
   ```

   The lifecycle rule is a backstop: held messages are normally deleted when
   delivered or abandoned.

3. **Worker.** From this directory. Use `bunx`: `npx` runs Wrangler from the
   nearest `package.json` (`apps/server`), where it cannot find this Worker's
   configuration.

   ```sh
   bunx wrangler secret put INTAKE_TOKEN   # the same value as EMAIL_BRIDGE_INTAKE_TOKEN
   bunx wrangler deploy
   ```

   `PROVIDER_ORIGIN` and `ALIAS_DOMAIN` are set in `wrangler.jsonc`.

4. **Routing.** On the `haili.email` zone, enable Email Routing and set the
   **catch-all** rule to *Send to a Worker* → `hail-email-bridge`. Add no other
   rules for the zone.

5. **Check.** Send a message to `nobody@haili.email`; it should be refused with
   "No such recipient". Then turn on Inbound email in the web client, create an
   alias, send to it, and confirm the message reaches the Feed.

## Tests

`apps/server/test/cloudflare-email-worker.test.ts` covers the handler and
retry logic. The contract test in
`apps/server/test/email-bridge-pipeline.integration.test.ts` runs this Worker
against the provider's real intake routes and database.
