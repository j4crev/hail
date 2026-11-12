# Email bridge conversion

Converts one raw email into Safe Portable Text blocks for the inbound email
bridge described in the [implementation plan](../../agents/email-bridge-plan.md).
This is reference-provider tooling, not a protocol requirement.

The package performs no network, database or filesystem access; fetching
images is delegated to a function the caller supplies. It parses hostile input,
so it is meant to run in the isolated converter process, never in the provider
process that holds keys.

## What it produces

`convertEmail(raw, limits?)` returns:

- `source`: sender address and name, subject, `List-Id`, `Message-ID` and date.
- `blocks`: `spt-2` text blocks, valid as emitted, interleaved with
  `bridge.image` references. An image reference is not an SPT node; a later
  stage resolves it to a bundled asset or replaces it with a link.
- `inlineImages`: bytes of `cid:` image parts.
- `diagnostics`: a count of everything dropped or degraded.

It throws `BridgeInputError` only when nothing usable can be produced: an empty
or unparseable message, one over the size bound, or one with no sender.

## Conversion rules

- The HTML part is used when present and within its size bound; otherwise the
  plain-text part.
- The subject becomes a leading `h1`, which clients show as the message title.
- Headings map to `h1`–`h3`; `h4`–`h6` become `h3`. Lists nest to three levels.
- Layout tables are flattened into document order.
- A link styled as a button, or the only content of a filled table cell, becomes
  a `cta` block when its label fits. Otherwise it stays an ordinary link.
- Links must be absolute HTTPS without credentials and at most 2048 bytes. Other
  destinations are dropped and their text kept.
- Scripts, styles, forms, frames, embedded media and inline-hidden content
  (including preheaders) are dropped.
- Images declared one or two pixels wide or high are treated as tracking pixels.
- One line break is a line break; two end the paragraph.
- Output stays inside the block, item and text budgets in `DEFAULT_LIMITS`. A
  message that exceeds them is cut and ends with a visible notice.

## Assembling a body

`assembleBody(converted, options)` turns that result into a body ready to sign.
The caller supplies what only the receiving side knows (the DKIM outcome and
receive time) and a function that fetches a remote image safely. The package
still makes no network request itself.

- An image is bundled when it is in an admitted format, structurally valid,
  static, and inside the per-image and whole-body budgets of the `ImagePolicy`.
  The default policy is today's `spt-3` rule set: PNG only, eight images.
- Any other image becomes a text link to the destination it pointed at, or to
  the image itself.
- An image smaller than three pixels in either direction is dropped as a tracker.
- A bundled image with no alternative text gets the fixed text "Image without a
  description". A bundled image that was a link is followed by a caption block
  carrying that link.
- The result carries the signed `origin` statement and has already been encoded
  and validated by the reference codec.

`probeImage` reads format, dimensions and animation from image headers for
measurement and pre-checks. It is not structural validation.

## Measuring a corpus

```sh
bun run --cwd packages/hail-email-bridge measure <directory of .eml files> [--fetch-images] [--json <file>]
```

The report gives percentiles for blocks, items, body size and images, plus how
often each diagnostic occurred. It is the input for choosing body and image
limits.

`--fetch-images` downloads every remote image in the corpus. Senders see those
requests, so the messages will be recorded as opened. Keep real mail out of the
repository; commit only synthetic fixtures.

## Tests

```sh
bun run --cwd packages/hail-codec-ts build
bun run --cwd packages/hail-email-bridge test
```

Tests validate every emitted text block with the reference codec and include a
seeded robustness run over arbitrary markup.
