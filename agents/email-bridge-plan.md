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
  port. It lives under `deploy/` as one deployment choice. Still to verify:
  catch-all routing on a subdomain, the Worker's maximum message size, and
  SMTP-time rejection from the Worker.
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

### D4. Body and image limits (measured 2026-11-11; **confirm** the recommendation)

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

**Recommendation:** admit JPEG, raise image blocks from 8 to 24, and raise the
per-image size from 192 KiB to 512 KiB. Leave everything else alone:

| Limit | Current | Recommended |
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

The same limits and the PNG-only rule are currently repeated in about ten
places: both codecs, the renderer, the builder core and editor, the composer
and the draft form. Changing them is one coordinated edit, so it waits for the
measured numbers rather than being done twice. Exporting the limits from the
codec as constants first would make that edit, and any later one, a single
change.

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
- [ ] Choose the bridge subdomain and the bridge account's address.

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
- [ ] Specify the new image formats, limits, alt-text marker and image-link rule
  in [bodies](../spec/bodies.md) and [assets](../spec/assets.md).
- [ ] Update the compressed-transfer ceiling in [bodies](../spec/bodies.md) and
  [HTTP binding](../spec/http-binding.md), and CBOR budgets in
  [encoding](../spec/encoding.md) if the larger body exceeds them.
- [ ] Update `spec/hail.cddl`, the version inventory in `spec/README.md`, and the
  Internet-Draft source if its body section states the old limits.
- [ ] Implement in `packages/hail-codec-ts` and `packages/hail-codec-go`.
- [ ] Add positive and negative vectors: each format, each limit boundary,
  `origin` present/absent/malformed.
- [ ] Update `packages/hail-content-builder` rendering and its compatibility
  inventory so the composer and reader accept the new content.
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
- [ ] Implement the fetcher the converter container injects, on the existing
  safe-fetch path (`apps/server/src/discovery/safe-fetch.ts`): HTTPS only, no
  private addresses, no credentials, bounded size, time and redirects.
- [ ] Tests for slow, redirecting and private-address image URLs against that
  fetcher.
- [ ] Bound total fetch time per message.
- [ ] Admit JPEG and WebP once the profile does, moving their structural
  validators from `apps/server/src/bodies/image-attachments.ts` into the codec.

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
- [ ] Verify DKIM from the raw message and record the result in `origin`.
- [ ] Never generate a bounce or any outbound email. Refusal happens only as an
  SMTP-time rejection by the ingress adapter.
- [ ] Worker for the durable queue between intake and conversion, with bounded
  retries and a dead-letter state visible to the operator. The queue table and
  its states exist; nothing consumes it yet. The queue is the only interface
  between the provider and the converter container (D7).
- [ ] Provider revalidates every converted body with the codec and the D4
  limits before signing; a rejected result goes to dead-letter.
- [x] Integration tests against disposable PostgreSQL: unknown alias, paused
  alias, deleted alias, duplicate delivery, oversize, rate limit, quota.

### Phase 5: bridge identity and delivery

- [ ] Create the bridge account, DID, address binding and Sender Profile with a
  single category.
- [ ] Add a single-recipient, Grant-authorized send path for the bridge account.
  `AccountPublications` currently fans one body out to category subscribers;
  the bridge sends a different body to exactly one grantee.
- [ ] Deliver only when the recipient has an active Grant to the bridge; hold or
  drop otherwise, without revealing Grant state to the email sender.
- [ ] Confirm collocated delivery (bridge and recipient on the same provider)
  takes the normal acceptance path and writes normal evidence.
- [ ] End-to-end integration test: raw message in, Feed item out, with exact
  envelope and body bytes retrievable through JMAP.

### Phase 6: account API and web client

- [ ] JMAP collection and operations for aliases: list, create, rename label,
  pause, resume, delete. Document in the JMAP collection and operation specs as
  reference-provider extensions.
- [ ] One-time enablement that creates the Grant to the bridge, using the
  existing passkey-confirmed managed approval. Creating aliases afterwards needs
  no further passkey prompt.
- [ ] Alias management screen: create with a label, copy address, see last
  received and message count, pause, delete.
- [ ] Feed rows and message view show the email sender from `origin`, a bridged
  label, the authentication result, and the alias that received it.
- [ ] Replace Unsubscribe on bridged messages with "Delete this alias".
- [ ] Hide Reply on bridged messages.
- [ ] Empty-Feed state for new accounts points to alias creation.
- [ ] Browser check script covering enablement, alias creation, a delivered
  bridged message and alias deletion; add to CI.
- [ ] Add a fictional bridged message to the `preview:design` fixture.

### Phase 7: CLI

- [ ] Confirm bridged messages already appear in `racr` inbox and wait commands.
- [ ] Display `origin` in message output and the JSON contract; update
  `apps/cli/docs` and the generated reference.
- [ ] Alias list/create/delete commands, if the operator wants them in the CLI.

### Phase 8: ingress adapters and deployment

- [ ] Cloudflare adapter: Email Worker source under `apps/server/deploy`,
  separate from the monitor's worker, passing the intake contract tests.
- [ ] Self-hosted adapter: a receive-only SMTP service, or a documented hook
  for an existing mail server, passing the same contract tests. Document it in
  the standalone deploy guide.
- [ ] Both adapters return a temporary SMTP failure when the provider is
  unavailable; neither accepts mail it cannot hand over or sends a bounce.
- [ ] No Cloudflare-specific name, header or format appears in `apps/server/src`
  or `packages/hail-email-bridge`; check this in review.
- [ ] Converter entry point in `apps/server` that works the conversion queue
  and exits cleanly on shutdown; it loads no messaging or identity keys.
- [ ] Add the converter service to the public and standalone Compose files,
  using the same provider image reference, with a memory limit, read-only
  filesystem, no published ports, and outbound network access for image fetches
  only.
- [ ] Dedicated database role for the converter, granted only the conversion
  queue and result tables; integration test proves it cannot read messages,
  keys or account tables.
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
