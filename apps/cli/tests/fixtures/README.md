# CLI read contract

`read-contract.json` contains 134 read, polling, diagnostic, error and simple-write
results captured from the TypeScript CLI immediately before its removal. Capture
also ran the Rust executable and compared its JSON, request paths, saved bytes,
exit status and error metadata against each result.

Only the disposable HTTPS origin is replaced with `$PROVIDER`; error message prose
is omitted because the contract specifies error codes/metadata, not exact wording.
Success JSON, request ordering, saved bytes and file modes remain fixed. The native
regression suite consumes every record, including interruption and TLS rejection.
Update expectations only for intentional reviewed contract changes; do not generate
them from the implementation under test merely to make a failing test pass.

JMAP deletion now has live HTTPS cases in `jmap-cases.ts`; obsolete permanent-delete request captures were removed.

Delivery-cursor inbox-wait captures were removed. Current inbox-wait coverage uses JMAP state/change HTTPS fixtures in `jmap-cases.ts`; migrated endpoints are rejected on the fixture wire.
