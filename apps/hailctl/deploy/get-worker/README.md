# get.racrproto.com

`curl -fsSL https://get.racrproto.com | sh` installs `hailctl` and starts a provider
install. This Worker redirects `/` (and `/install.sh`) to `install.sh` in the newest
`provider-vX.Y.Z` release that ships it, read from the public releases feed and cached
for five minutes. It does not need GitHub API access.

`/provider-vX.Y.Z` redirects to that release's `install.sh`, for a fresh install of a
specific release (0.3.0 or later): `curl -fsSL https://get.racrproto.com/provider-v0.3.0 | sh`.

The Worker only chooses a release. `install.sh` verifies the release manifest's
signature against the pinned key with `openssl` and installs `hailctl` only when its
SHA-256 matches the signed manifest; `hailctl` verifies again before installing
anything else.

Deploy (the `racrproto.com` zone must be in the Cloudflare account):

```bash
cd apps/hailctl/deploy/get-worker
bunx wrangler deploy
```

Raise `MINIMUM` in `worker.ts` only when older installers are unusable. It is 0.3.0
because the 0.2.0 installer writes a configuration the provider refuses to start with.
