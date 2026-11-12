# Inbound email bridge plan

Status: nonnormative implementation plan. Created 2026-11-11. Nothing here is
implemented, deployed or authorized for deployment. [`spec/`](../spec/README.md)
remains authoritative; protocol changes listed below must update specifications,
CDDL, both codecs and vectors in the same change as their implementation.

## 1. Outcome

A Hail user creates a private email alias per newsletter (for example
`x7k2m9qd@in.haili.app`), subscribes to that newsletter with it, and reads the
issues in their Feed. Deleting the alias stops that newsletter without the
sender's cooperation. Nothing is ever sent by email: the bridge is receive-only.

The purpose is adoption: a new account can have a useful Feed on day one, before
any publisher supports Hail natively.

Out of scope: sending email, replying to bridged mail, person-to-person email,
importing an existing mailbox, and a general `user@haili.app` email address.

## 2. Findings that shape the design

- **Mailbox storage requires a real envelope.** `delivered_messages` has
  foreign keys to `received_envelopes` and `verified_body_provenance`, the JMAP
  message object exposes `sender`/`recipient` DIDs and exact envelope bytes, and
  Feed/Inbox classification reads `envelope.authorization_type`
  (`apps/server/src/accounts/messaging.ts`). A message without an envelope fits
  none of this.
- **Production has no public ingress.** The provider is reachable only through a
  Cloudflare Tunnel; public ports are blocked ([operations](haili-operations.md)).
  It cannot accept SMTP on port 25.
- **A Cloudflare Worker pattern already exists** for signup email
  (`apps/plc-monitor/deploy/cloudflare-alert-worker`), called from
  `apps/server/src/onboarding/email.ts` with a bearer token.
- **The server never decodes pixels.** JPEG and WebP structural validators
  already exist for attachments (`apps/server/src/bodies/image-attachments.ts`);
  bundled body images are PNG-only.
- **Storage is measured, not limited.** `apps/server/src/bodies/usage.ts` states
  it is not quota enforcement. Inbound email needs a real limit.
- **`spt-3` rejects common newsletter content:** more than eight images, non-PNG
  images, images without alt text, and linked images.

## 3. Decisions

Each has a recommendation. Items marked **confirm** should be settled before the
phase that depends on them.

### D1. The bridge is a real Hail sender (recommended)

The bridge has its own `did:plc` identity, address and Sender Profile. It turns
each accepted email into a normal Grant-authorized envelope and body, signed by
the bridge, addressed to the user's DID. The user holds one Grant to the bridge.

Why: every existing path works unchanged (delivery, Feed, read/Trash, push, CLI,
account history, provider transfer). The alternative, a provider-local store for
bridged mail, needs parallel tables, a second JMAP type, merged pagination and a
new history collection.

The bridge signature attests only "the bridge received this by email". It does
not attest who wrote it. Clients must show that distinction (D3).

Consent has two levels: revoking the Grant stops all bridged mail; deleting one
alias stops one newsletter. Alias deletion is bridge-local state.

### D2. Provider-neutral intake contract; mail reception is an adapter (decided 2026-11-11)

The bridge does not receive SMTP and has no dependency on any mail vendor. It
exposes a small authenticated HTTP intake contract:

- **Check:** is this recipient alias live? Answered before the message is
  accepted, so the adapter can refuse at SMTP time.
- **Submit:** the raw RFC 5322 message bytes for one alias, plus what only the
  receiving edge knows: envelope sender, connecting address and receive time.

Whatever accepts mail for the bridge domain is an *ingress adapter* that calls
this contract. The bridge core, the converter, the alias store and delivery
contain no adapter-specific code, configuration names or data formats.

Rules every adapter follows:

- Refuse unknown, paused or over-limit aliases during the SMTP transaction when
  the edge allows it. An edge that cannot refuse must discard silently.
- Never generate a bounce or any other outbound email.
- Return a temporary failure when the provider is unreachable, so the sender
  retries. Never accept mail it cannot hand over.
- Pass the message bytes unmodified. DKIM is verified by the bridge from those
  bytes, so correctness does not depend on the adapter's own checks.

Adapters:

- **Cloudflare Email Routing with an Email Worker**, for haili.app. Production
  has no public ingress, so this is the only option there without opening a
  port. It lives under `deploy/` as one deployment choice. Checked against the
  docs (2026-11-11): Workers can reject with a permanent SMTP error and accept
  25 MiB, but **catch-all rules exist only on a zone's apex**, and literal rules
  are capped at 200 per domain. A subdomain such as `in.haili.app` therefore
  cannot route arbitrary aliases. **Decided (2026-11-11):** a separate zone,
  `haili.email`, with its apex catch-all sent to the Worker. Plus addressing
  on `in.haili.app` was rejected because signup forms often refuse `+`.
  Workers also cannot return a temporary SMTP failure, so the adapter holds
  mail in R2 and retries from a queue when the provider is unavailable.
- **Self-hosted SMTP receiver**, for providers that run their own mail edge: a
  small receive-only service, or a documented hook for an existing mail server,
  calling the same contract. Without it the standalone deployment guide has no
  way to enable the feature.
- Hosted inbound-mail services that post raw messages to a webhook can be
  supported by a thin translation to the same contract. None is planned.

### D3. A signed `origin` field on bodies (recommended, protocol change)

Add one optional member to `spt-2`/`spt-3` bodies stating that the sender relayed
the content from an external source:

```text
origin = {
  type: "email",
  from_address, ? from_name,
  ? list_id,
  authentication: "dkim-aligned" / "none",
  received_at
}
```

`dkim-aligned` requires a valid signature from the author's own registrable
domain. A valid signature for an unrelated domain says nothing about the
author, so it is reported as `none` rather than as a separate failure value.

Clients show the email sender as the row title, labelled as bridged, with the
bridge DID as the verified Hail sender. Without this field every newsletter
appears as one sender named "Email bridge".

The same field would serve an RSS bridge later. It is defined once, generically.

### D4. Body and image limits (measured and decided 2026-11-11)

Measured on 83 real messages from 74 sender domains, with every remote image
downloaded: 477 real images, plus 94 tracking pixels that were dropped.

| Finding | Value |
| --- | --- |
| Messages converted | 83 of 83 |
| Text blocks per message | median 18, 95th percentile 60, largest 153 |
| CBOR items per message (limit 16,384) | largest 3,441 |
| Text-only body size | 95th percentile 19 KiB, largest 50 KiB |
| Images per message | median 4, 90th percentile 13, 95th 16, largest 46 |
| Image formats | PNG 386, JPEG 47, static GIF 27, animated GIF 23, WebP 0 |
| Image bytes | median 5 KiB, 90th percentile 240 KiB, 95th 1 MiB, largest 3.6 MiB |
| Images over 2 megapixels | 12 |

How much each candidate rule set would bundle (the rest become links):

| Rule set | Images bundled | Messages with every image bundled |
| --- | ---: | ---: |
| Today: PNG, 8 images, 192 KiB each | 56% | 38% |
| Add JPEG | 62% | 50% |
| Add JPEG, 24 images | 77% | 60% |
| **Add JPEG, 24 images, 512 KiB each** | **79%** | **66%** |
| The same plus static GIF | 82% | 68% |
| 32 images, 1 MiB each, 4 MiB body | 82% | 70% |

**Decision, implemented:** admit JPEG, raise image blocks from 8 to 24, and
raise the per-image size from 192 KiB to 512 KiB. Everything else is unchanged:

| Limit | Before | Now |
| --- | ---: | ---: |
| Image formats | PNG | PNG, JPEG |
| Image blocks per body | 8 | 24 |
| Bytes per image | 192 KiB | 512 KiB |
| Per-image dimensions and pixels | 2400 × 2400, 2 million | unchanged |
| Decoded pixels, total | 8 million | unchanged |
| Complete body | 1 MiB | unchanged |
| Compressed transfer ceiling | 2 MiB | unchanged |

Why the body ceiling can stay: under the recommended rules the largest body in
the corpus is 818 KiB and the 90th percentile is 442 KiB. The total-pixel budget
never refused an image. So the cost of running a conforming provider does not
rise, and the transfer ceiling and CBOR budgets need no change.

What stays unbundled, and why it is not worth chasing yet:

- **Oversized images (5%).** Mostly multi-megabyte PNG hero images. Only
  transcoding would bring them in (D6).
- **Animated GIF (5%)** and **static GIF (5%).** See D5. Static GIF would add
  three points for a new validator in both codecs.
- **Unavailable (5%).** Almost all were HTTP 403 or 406 refusals of the
  measurement script's bare request. The real fetcher should send ordinary
  browser-style `Accept` and `User-Agent` headers and be re-measured.
- **WebP** did not occur at all, so it is not worth adding for the bridge.

The earlier guess of a 4 MiB body and 24 million pixels was larger than the
evidence supports and is withdrawn.

Two rule changes considered here turned out not to need the protocol
(decided 2026-11-11):

- **Missing alternative text.** The bridge states it plainly, using the fixed
  text "Image without a description", instead of adding a marker to the format.
- **Linked images.** Image blocks still carry no destination. The bridge
  follows a linked image with a caption block linking to that destination.

The limits now live in one place: the TypeScript codec exports
`BUNDLED_IMAGE_LIMITS`, which the renderer and the bridge read, and the Go
codec has matching constants.

**Authoring is widened to match (decided 2026-11-11).** Organizations moving
their newsletters to Hail should be able to compose what the bridge can
deliver. The content builder and the simple composer's cover image now accept
PNG or JPEG up to 512 KiB, and the builder up to 24 images.

That required raising what a draft can hold, because drafts store images inline
as base64url and a body at the 1 MiB ceiling is about 1.4 million JSON bytes:

| Limit | Before | Now |
| --- | ---: | ---: |
| Builder body, as JSON | 360,000 bytes | 1,450,000 bytes |
| Stored draft content (migration 121) | 400,000 bytes | 1,500,000 bytes |
| One `HailDraft/get` response | 2 MiB | 6 MiB (still four maximum drafts) |
| Simple-compose cover image in a draft | 192 KiB PNG | 512 KiB PNG or JPEG |

The draft schema is part of both account-transfer formats, so the generated
transfer schema changed in those draft fields. No format version changed, in
line with the pre-launch policy. Consequences to keep in view:

- A transfer snapshot is capped at 64 MiB with no pagination. Larger drafts mean
  fewer of them fit before an export fails closed. Nothing limits how many
  drafts or how many draft bytes an account holds.
- The draft list still loads every draft's full content, four at a time.

A fault surfaced while doing this: the codec's JSON input path measured a body's
base64 text against the 1 MiB byte limit, so it rejected any body holding more
than about 780 KiB of images even though the binary path accepted it. That path
serves composing, forwarding and drafts. It now bounds the JSON form by its
inflated size and applies the real limits after conversion.

**Checked end to end** against the corpus with real downloads: all 83 messages
assemble into codec-valid bodies, 82% of their images are bundled, the largest
body is 838 KiB, and all 47 real JPEGs pass the structural validator. Two
findings for the real fetcher: sending a browser-style `User-Agent` cut refused
requests from 24 to 6, and the `Accept` header must ask for PNG and JPEG only,
because many image hosts otherwise answer with WebP.

### D5. GIF (**confirm**)

Options: static GIF only with a bounded validator; animated GIF with frame and
byte caps; or no GIF, with the bridge substituting a link.
Recommended: no GIF in the first release. In the measured corpus GIF is 10% of
images, half of it animated. The animated ones include several of 2 MiB or
more, which cannot fit a 1 MiB body at any setting.

### D6. No image transcoding in the first release (recommended)

An image that fits the limits and passes structural validation is bundled
unchanged. Anything else becomes a text placeholder linking to the original.
This keeps the "never decode pixels" property and adds no native image library.
Revisit only if measurement shows too many placeholders.

### D7. Bridge lives in the provider; conversion runs in its own container (decided 2026-11-11)

Alias tables, the intake endpoint and delivery are a module in `apps/server`.
The bridge identity is an ordinary provider account whose messages go through
the normal sender path. It is reference-provider policy, not a protocol
requirement, and can be extracted into a standalone service later.

MIME/HTML conversion and image fetching run in a second Compose service started
from the same provider image with a converter command. That container has a
memory cap, no messaging or identity keys, and database access limited to the
conversion queue and its results. The provider process never parses email or
fetches sender-chosen URLs. No new image is published, so the release procedure
keeps its two digests.

The converter returns an unsigned body and diagnostics. The provider validates
that body with the normal codec before the bridge account signs anything; a
compromised converter can produce bad content but cannot sign or deliver.

### D8. Aliases on provider transfer (**confirm**)

Aliases belong to the bridge's domain, not the user's DID. Recommended first
behaviour: aliases are disabled at cutover and the transfer flow warns about it.
Later option: keep delivering to the DID at its new provider, which the protocol
already supports, once alias management no longer needs a local account.

### D9. Raw message retention (**confirm**)

Recommended: discard the raw message once the envelope is accepted; keep only a
digest and the `Message-ID` for duplicate detection. Keeping originals helps
debugging and re-conversion but stores unreviewed HTML and tracking content.

## 4. Flow

```text
newsletter -> MX -> ingress adapter (Cloudflare Worker, or a self-hosted receiver)
  -> provider: is alias live?      no  -> reject at SMTP time
                                   yes -> submit raw message
provider intake: size/rate checks -> queue
converter: parse MIME -> verify DKIM -> HTML to SPT -> fetch and bundle images
bridge account: publish body -> sign envelope -> normal Grant delivery to user DID
user: Feed item, labelled as bridged email from <newsletter>
```

## 5. Checklist

### Phase 0: measurement and decisions

- [x] Collect a corpus of real messages across text-heavy, retail and digest
  styles: 83 messages from 74 sender domains, kept outside the repository.
- [x] Write a dry-run converter harness that reports, per message: image count,
  formats, bytes and dimensions per image, converted body size, and every
  dropped or degraded element. See `packages/hail-email-bridge/scripts/measure.ts`.
- [x] Record the distribution and derive D4 limits from it. The corpus also
  exposed two converter faults, now fixed with a regression test: `font-size:0`
  on layout containers and `mso-hide:all` were wrongly treated as hidden
  content, which emptied four messages.
- [ ] Verify the Cloudflare Email Routing assumptions in D2 for the haili.app
  adapter.
- [ ] Confirm D4, D5, D8 and D9 with the operator.
- [x] Choose the alias domain and the bridge account's address: `haili.email`
  and `email@haili.app`.

### Phase 1: protocol changes

- [x] Specify `origin` in [bodies](../spec/bodies.md#relayed-origin), including
  rendering requirements and the statement that it is a sender attestation, not
  proof of authorship. Also in `spec/hail.cddl`, the profile inventory and the
  deferred-features table.
- [x] Implement `origin` in both codecs, with two positive and ten negative
  shared vectors.
- [x] Reference-provider policy: the account compose API rejects `origin`, and
  forwarding drops it and records the email sender as provenance text.
- [ ] Mention `origin` in the Internet-Draft body section when that section is
  next revised for the new limits.
- [x] Specify JPEG and the new limits in [bodies](../spec/bodies.md) and
  [assets](../spec/assets.md). No alt-text marker or image-link rule was needed.
- [x] The body ceiling, compressed-transfer ceiling and CBOR budgets are
  unchanged, so the HTTP binding and encoding specifications need no edit.
- [x] Update `spec/hail.cddl` and the version inventory in `spec/README.md`.
- [x] Implement in `packages/hail-codec-ts` and `packages/hail-codec-go`,
  including a JPEG structure validator in each. The server's attachment check
  now delegates to the codec's.
- [x] Add vectors: a JPEG body, a full 24-image body, wrong-format bytes,
  truncated JPEG, dimension mismatch, unsupported type, 25 image blocks and a
  JPEG avatar. The per-image byte limit is covered by unit tests rather than a
  vector, which would be over a megabyte of hex.
- [x] Update the renderer in `packages/hail-content-builder` to accept the new
  content.
- [ ] Revise the Internet-Draft. It is pinned to specification snapshot
  `7f05efc` and still correctly describes that snapshot; the next revision must
  re-pin and carry the new limits, JPEG and `origin` together.
- [x] Widen authoring (builder, composer, drafts) to match; see D4.
- [ ] Decide on a per-account limit for draft count or draft bytes, given the
  64 MiB transfer snapshot.
- [ ] Record the email bridge in `spec/` as reference-provider policy, replacing
  "No interoperable bridge profile" with an accurate description.

### Phase 2: conversion library

Implemented in [`packages/hail-email-bridge`](../packages/hail-email-bridge/README.md)
(2026-11-11). It emits valid `spt-2` text blocks plus unresolved image
references; Phase 3 turns those into bundled assets or links.

- [x] New package for MIME parsing and HTML-to-SPT conversion, with no network
  or database access, so it is testable from fixtures alone.
- [x] Parse multipart messages; prefer the HTML part, fall back to plain text.
- [x] Map headings, paragraphs, blockquotes, lists, emphasis, links and
  button-like links (to `cta`). Flatten layout tables into document order.
- [x] Drop scripts, styles, forms, embedded frames and hidden preheader text.
- [x] Reject non-HTTPS links per the existing link rules, keeping their text.
- [x] Emit a diagnostics list of everything dropped or degraded.
- [x] Enforce node, depth and size budgets; truncate with a visible notice
  rather than failing the whole message.
- [x] Seeded robustness test: arbitrary markup never yields a text block the
  codec rejects.
- [ ] Fixture tests from synthetic newsletters covering each style in the
  corpus. One synthetic newsletter exists; add the rest once the corpus shows
  which styles matter.
- [ ] Add the "view original" link to the truncation notice once the bridge
  records one (for example from `List-Archive` or a "view in browser" link).
- [ ] Revisit converter rules against the corpus: hidden content that relies on
  `<style>` rules, small decorative icons, and headings expressed only through
  font size are not detected.

### Phase 3: image handling

`assembleBody` in `packages/hail-email-bridge` implements the policy side
(2026-11-11): it takes the converted blocks, an injected image fetcher and an
`ImagePolicy`, and returns a codec-validated `spt-2` or `spt-3` body with the
origin statement. The policy defaults to today's `spt-3` rules; the measured
limits and new formats become a change to that one object.

- [x] Resolve `cid:` references to inline MIME parts.
- [x] Drop tracking pixels, by declared size during conversion and by real size
  after fetching.
- [x] Validate structure and dimensions; bundle images that fit; substitute a
  link for the rest (D6).
- [x] Enforce image count, per-image, total-pixel and complete-body budgets,
  and cap remote fetches per message. A repeated image is fetched once.
- [x] Tests for unsupported, oversized, malformed, unavailable and failing
  images, and for each budget.
- [x] Implement the fetcher the converter injects
  (`apps/server/src/bridge/image-fetcher.ts`) on a new image mode of the safe
  transport: HTTPS on port 443, public addresses only, no credentials, bounded
  size, at most three redirects and 15 seconds per image.
- [x] Tests for redirects, non-HTTPS redirects, redirect loops, oversized and
  mis-declared responses, and transport refusals.
- [ ] Bound total fetch time per message. Today it is bounded only by 48
  fetches of 15 seconds each.
- [x] Admit JPEG, validated by the codec.
- [x] The fetcher sends a `User-Agent` naming the bridge and an `Accept`
  header naming only PNG and JPEG (see D4). Not re-measured against the corpus
  with that exact `User-Agent`.

### Phase 4: aliases and intake

Aliases and intake are implemented in `apps/server/src/bridge` with migration
120 (2026-11-11). The routes are mounted only when `EMAIL_BRIDGE_DOMAIN` and
`EMAIL_BRIDGE_INTAKE_TOKEN` are both set. The deployment Compose files do not
pass those through yet, on purpose: until conversion and delivery exist,
enabling intake would accept mail that is never delivered.

- [x] Migration: aliases (account, local part, label, state, created, last
  received, message count) and an intake ledger keyed by alias plus
  `Message-ID` digest for duplicate rejection.
- [x] Alias local parts are sixty random bits, lowercase base32, never reused
  after deletion.
- [x] Specify the intake contract (D2) in [spec/email-bridge.md](../spec/email-bridge.md)
  as reference-provider policy: check and submit requests, authentication, size
  and rate responses, and the adapter rules. It names no vendor.
- [x] Implement the check and submit endpoints, authenticated with a dedicated
  bearer token. An adapter such as the Cloudflare one reaches them through the
  provider's public hostname, so the token is the control; a deployment may
  additionally restrict the path at its proxy.
- [x] Integration tests for live, unknown, paused, deleted and over-limit
  aliases, oversize, duplicates, concurrent resends and fenced accounts.
- [ ] Package those cases as a contract suite an adapter can be run against,
  including provider-unavailable.
- [x] Enforce maximum message size, per-alias and per-account rate limits, a
  per-account ceiling on mail awaiting conversion, and a per-account alias cap.
- [ ] Enforce a per-account storage ceiling for delivered bridged content.
- [ ] Make the intake and alias limits configurable; they are constants today.
- [ ] Clean up content-free intake records after a retention period.
- [x] Verify DKIM from the raw message and record the result in `origin`
  (`mailauth` 8.0.4, in the converter only). Tested with locally signed
  messages; the corpus cannot test it because its export altered every body.
- [ ] Never generate a bounce or any outbound email. Refusal happens only as an
  SMTP-time rejection by the ingress adapter.
- [x] Converter worker for the queue (`apps/server/src/bridge/converter.ts`),
  with leases, bounded retries and a `dead` state carrying a failure reason.
- [ ] Make `dead` records and their reasons visible to the operator. The queue is the only interface
  between the provider and the converter container (D7).
- [ ] Provider revalidates every converted body with the codec and the D4
  limits before signing; a rejected result goes to dead-letter.
- [x] Integration tests against disposable PostgreSQL: unknown alias, paused
  alias, deleted alias, duplicate delivery, oversize, rate limit, quota.

### Phase 5: bridge identity and delivery

The bridge account is an ordinary local account the operator creates and
names in `EMAIL_BRIDGE_SENDER`; see the operator setup in
[spec/email-bridge.md](../spec/email-bridge.md#operator-setup).

- [x] Add a single-recipient, Grant-authorized send path for relay services
  (`AccountMessaging.sendRelayed`). Unlike the account API it accepts a body
  with an origin; nothing outside the provider can reach it.
- [x] Deliver only when the recipient has an active Grant to the bridge for its
  category; otherwise abandon. The email sender learns nothing either way.
- [x] Revalidate the converter's output before signing.
- [x] Integration tests from queued message to signed envelope, including
  missing Grants, other categories, paused aliases, forged bodies, lost
  submissions and a missing bridge account.
- [ ] Integration test through collocated acceptance to a Feed item readable
  over JMAP. The delivery tests stop at submission.

### Phase 6: account API and web client

Decided with the operator (2026-11-11): an **Aliases** sidebar item under
Categories, shown only when the provider offers the bridge, modelled on
Subscriptions; generic `@` avatars that select aliases for deletion; a floating
plus button to create one; and an **Inbound email** switch in Settings. No
empty-Feed prompt.

- [x] Account API: `HailEmailAlias/get`, `create` and `destroy`
  (`apps/server/src/bridge/operations.ts`), documented in
  [spec/email-bridge.md](../spec/email-bridge.md#account-api). Rename and pause
  exist in the alias store but are not exposed, to keep the screen simple.
- [x] Inbound email switch: turning it on is the ordinary passkey-confirmed
  Grant to the bridge account; turning it off revokes it. Alias creation
  requires it, and intake refuses mail for accounts that have it off.
- [x] Aliases screen: list, create with a label and copy the address, select
  and delete with confirmation. Design-preview fixture updated.
- [ ] Feed rows and message view show the email sender from `origin`, a bridged
  label and the authentication result, and hide Reply.
- [ ] Replace Unsubscribe on bridged messages with "Delete this alias".
- [ ] Browser check script covering the switch, alias creation and deletion;
  add to CI. The design preview cannot exercise the switch, which needs a passkey.

### Phase 7: CLI

- [ ] Confirm bridged messages already appear in `racr` inbox and wait commands.
- [ ] Display `origin` in message output and the JSON contract; update
  `apps/cli/docs` and the generated reference.
- [ ] Alias list/create/delete commands, if the operator wants them in the CLI.

### Phase 8: ingress adapters and deployment

- [x] Cloudflare adapter: `apps/server/deploy/cloudflare-email-worker`, with
  R2-and-queue retry for provider outages. Unit tests, and a contract test
  against the real intake routes and database.
- [ ] Deploy it for haili.app: provider settings, R2 bucket, queue, secret,
  Worker, and the `haili.email` catch-all (see its README). Operator steps.
- [ ] Self-hosted adapter: undecided whether to ship one (see D2). Other
  providers can implement the documented contract with their own mail edge.
- [x] The Cloudflare adapter never sends a bounce, and keeps mail it cannot
  hand over rather than refusing it; it cannot send a temporary failure.
- [x] No Cloudflare-specific name, header or format appears in `apps/server/src`
  or `packages/hail-email-bridge` (checked 2026-11-11; keep checking in review).
- [x] Converter entry point (`src/cli/email-bridge-converter.ts`) that works the
  queue and stops on SIGTERM. It loads no keys and refuses the provider's role.
- [x] Converter service in the standalone Compose file, behind the
  `email-bridge` profile: same image, 512 MiB limit, read-only, no ports, on the
  storage network plus an outbound-only network.
- [ ] The same for the public Compose file, after checking the installed
  `hail-provider-ops` wrapper (next item).
- [x] Database role script (`deploy/email-bridge/converter-role.sql`);
  integration test proves the role can convert but cannot read accounts, keys,
  aliases or messages, or insert or delete queue rows.
- [ ] Confirm the installed `hail-provider-ops` wrapper restarts and verifies
  the converter with the provider image. If the wrapper needs changing, that is
  a separate reviewed installation, per the release rules.
- [ ] Include the converter in health verification and in rollback: it must run
  the same digest as the provider.
- [ ] Provider keeps accepting and delivering native Hail messages when the
  converter is stopped; bridged mail queues and resumes.
- [ ] DNS: MX and SPF-null records for the bridge subdomain. Document them per
  adapter in the standalone and public deploy guides, with the feature off by
  default.
- [ ] Configuration: bridge domain, intake token, limits. Fail closed when
  partially configured.
- [ ] Operator view: intake volume, rejection reasons, dead-letter queue,
  per-account bridged storage.
- [ ] Update [production operations](haili-operations.md) and the
  [release process](release-process.md) for the new adapter, converter and secrets.

### Phase 9: rollout

- [ ] Enable for the operator's own account; subscribe to a varied set of
  newsletters for at least two weeks and review conversion diagnostics.
- [ ] Tune limits and converter rules from that evidence.
- [ ] Publish user documentation, including what is lost in conversion and that
  the provider and bridge can read bridged mail.
- [ ] Update the privacy documentation for inbound email handling and image
  fetching.
- [ ] Enable for all accounts.

## 6. Later work

- [ ] Pin an alias to the sender domains seen in its first days and flag mail
  from others as a leaked alias.
- [ ] Offer one-click `List-Unsubscribe` (RFC 8058) when an alias is deleted.
- [ ] Detect that a bridged sender's domain now publishes a Hail Address Binding
  and Sender Profile, and offer to switch to a native subscription.
- [ ] Report bridge readership per sender domain, in aggregate, as evidence for
  recruiting publishers.
- [ ] RSS bridge reusing the converter, the image pipeline and `origin`.
- [ ] Standalone bridge service with DID-authenticated alias management, so
  aliases survive provider transfer (D8).
- [ ] Image transcoding in an isolated process, if placeholders prove too common.

## 7. Risks

- **Conversion quality decides whether this helps.** A Feed of badly converted
  newsletters is worse than an empty one. Phase 0 and the two-week trial exist to
  find this out early.
- **The bridge is a concentrated target.** It holds every alias and reads all
  bridged mail. Conversion parses hostile MIME and HTML and fetches
  attacker-chosen URLs; the separate converter container (D7), the safe-fetch
  path and input bounds are the main defences.
- **Storage growth.** Newsletters with bundled images are far larger than
  current messages. The storage ceiling in Phase 4 is required, not optional.
- **Larger bodies affect every provider.** Raising the mandatory body ceiling
  raises the cost of running any conforming provider, not only this one.
- **Image fetching is observable.** Fetching at ingest tells the sender that the
  alias is live and when mail arrived. It does not reveal opens.
