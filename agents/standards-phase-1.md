# Standards adoption: phase 1 completion evidence

Status: implemented and verified locally, 2026-11-10, working tree based on
`2bf1a8b`. Not committed, merged or deployed by this task. This completes the four
phase 1 items in [DESIGN.md](DESIGN.md#1-http-and-transport-foundations), with the
limits below. Phase 2's profile decisions and phase 3's retrieval signatures are
still open.

## Digest dictionaries

[Content-Digest validation](../apps/server/src/http/content-digest.ts) replaces the
single exact-string check shared by body and attachment retrieval. It uses pinned
`structured-headers` 2.1.1 with a temporary date-parser correction following
[upstream PR #89](https://github.com/evert/structured-headers/pull/89), already open
when checked. [Patch maintenance notes](../patches/README.md) define removal and
regression gates. Container install stages include the patch before installing.

The profile accepts legal dictionaries/parameters, checks all present SHA-256 and
SHA-512 digests, and bounds combined ASCII field input to 8192 octets and the
parsed dictionary to 16 distinct keys. Unknown algorithms are ignored only when
well formed; missing/unsupported transport evidence never bypasses signed content
checks. Duplicate keys follow Structured Fields' last-value semantics. See
[bodies](../spec/bodies.md) and [frozen vectors](../spec/vectors/content-digest.json).
Tests distinguish gzip-coded HTTP bytes from uncompressed signed body bytes and
prove a matching transport digest cannot legitimize a substituted body or file.

## Private caching and downloads

No cache-header implementation change was needed. Added tests verify `no-store`
on body/attachment successes, concealed misses, lookup/storage failures and account
authentication/scope errors. A simple compliant shared-cache test alternates valid
and invalid retrieval credentials at the same URL; account download tests change
sessions at the same URL. Client hook tests verify private pages/error responses
cannot inherit a cacheable header. Existing mailbox-cache and request-local
account-read tests prove separation of internal reuse from HTTP caching; retained
Sender Profile tests still revalidate current PLC authority after a 304 response.

[Download route](../apps/server/src/accounts/routes.ts) now percent-encodes
parentheses and asterisk as well as apostrophe in `filename*`. Tests retain exact
Unicode/reserved characters through encoding and verify existing codec rejection
of path separators, ASCII controls and DEL. The attachment profile documents this
header encoding without changing signed filenames or their validation schema.

## Real TLS and attachment transport

[SafeHttpsTransport](../apps/server/src/discovery/safe-fetch.ts) already retained
the selected hostname for HTTPS/SNI while pinning an approved public DNS answer.
The new [TLS test](../apps/server/test/safe-fetch-tls.test.ts) runs in a child process
with an ephemeral local CA/server. A test-only request wrapper supplies that CA
and redirects the socket to loopback after asserting the production DNS pin; it
does not replace TLS, hostname validation or HTTP response processing. No production
private-network bypass or custom trust option was added.

The test proves matching-host success, trusted wrong-host rejection before HTTP,
success/failure for DNS-selected delegated hostnames, rejection of mixed
public/private DNS answers before dialing, and no automatic redirect following.
Existing tests also cover literal IPs, ambient credentials and DNS deadlines.
This is real TLS with controlled DNS/socket routing, not a public network test or
an exhaustive TLS implementation audit.

The transport's canonical body-path allowlist previously rejected the attachment
URLs produced by the retriever. It now admits the exact
`bodies/{digest}/attachments/{digest}` GET shape, retaining query/method/header
restrictions. The real transport test verifies attachment success and rejection
of extra path/query components.

## Verification

```sh
bun install --frozen-lockfile
bun run --cwd apps/server test -- test/content-digest.test.ts test/body-retriever.test.ts test/body-retrieval-errors.test.ts test/bodies.test.ts test/attachments.test.ts test/attachment-routes.test.ts test/safe-fetch.test.ts test/safe-fetch-tls.test.ts test/address-verifier-delegation.test.ts test/sender-profile-verifier.test.ts test/protocol-interop-vectors.test.ts
bun run --cwd apps/server typecheck
bun run --cwd packages/hail-codec-ts test -- test/attachments.test.ts
bun run --cwd apps/client test -- src/lib/mailbox-cache.test.ts src/lib/account-reads.test.ts src/lib/auth-routing.test.ts
git diff --check
```

The 11 selected server suites pass (139 tests); server typecheck and the six codec
attachment tests pass. The three client suites pass; the additional rendered-page
cache regression also passes in a focused rerun. Frozen installation and whitespace
checks pass. TLS fixtures require OpenSSL, already used by repository test helpers.
Container patch inputs were updated; container images were not built or published.

## Cutover and limitations

This is an HTTP parsing/header/transport change. Existing signed bytes, tokens,
accounts, custody, authenticated history, consent and availability commitments
are unchanged; no data cleanup or schema/version bump is needed. The spec index,
HTTP/body/attachment profiles and vector index describe the new acceptance rules.
HTTP vectors are exercised by the reference receiver, not claimed as independent
cross-language HTTP conformance. The existing interoperability vector suite still
passes for signed formats.

Deploy providers with the new dependency/patch included. A rollback restores the
old restrictive dictionary parser, attachment-path rejection and filename encoding;
it does not require a data rollback. No production CDN/proxy cache configuration
was tested or changed, and no database integration suite was needed for these
non-storage changes. The supported-algorithm and input limits are explicit profile
choices; trailer digests are not required. Retrieval remains bearer-only until
phase 3, and the phase 2 envelope/snapshot decisions are unaffected.
