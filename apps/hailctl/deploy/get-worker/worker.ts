// get.racrproto.com: redirects to install.sh in the newest provider release, or in
// the release named by the path (`/provider-vX.Y.Z`).
// `curl -fsSL https://get.racrproto.com | sh` follows the redirect. install.sh
// verifies everything it downloads against the release signing key, so this
// Worker only chooses which release to start from.
const FEED = "https://github.com/j4crev/hail/releases.atom";
const DOWNLOAD = "https://github.com/j4crev/hail/releases/download";
/**
 * The first provider release whose installer is still supported: 0.4.0 runs providers as
 * an unprivileged user; earlier installers ran them as root (and 0.2.0's cannot start one).
 */
export const MINIMUM: [number, number, number] = [0, 4, 0];
const CACHE_SECONDS = 300;

type Version = [number, number, number];
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const TAG = /^\/(provider-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;

const redirect = (tag: string, cacheSeconds: number) =>
  new Response(null, { status: 302, headers: { Location: `${DOWNLOAD}/${tag}/install.sh`, "Cache-Control": `public, max-age=${cacheSeconds}` } });

/** The highest provider release tag in a GitHub releases Atom feed. */
export function latestTag(feed: string): string | null {
  let best: { tag: string; version: Version } | null = null;
  for (const match of feed.matchAll(/\/releases\/tag\/(provider-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))["<]/g)) {
    const version: Version = [Number(match[2]), Number(match[3]), Number(match[4])];
    if (compare(version, MINIMUM) < 0) continue;
    if (!best || compare(version, best.version) > 0) best = { tag: match[1]!, version };
  }
  return best?.tag ?? null;
}

interface Context { waitUntil(promise: Promise<unknown>): void }
interface CacheLike { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> }

export async function handle(request: Request, fetcher: typeof fetch, cache?: CacheLike, context?: Context): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET\n", { status: 405 });
  const pinned = TAG.exec(url.pathname);
  if (pinned) {
    const version: Version = [Number(pinned[2]), Number(pinned[3]), Number(pinned[4])];
    if (compare(version, MINIMUM) < 0) return new Response(`${pinned[1]} has no working installer; use provider-v${MINIMUM.join(".")} or later.\n`, { status: 404 });
    // A release's assets never change, so this redirect can be cached for a day.
    return redirect(pinned[1]!, 86400);
  }
  if (url.pathname !== "/" && url.pathname !== "/install.sh") return new Response("Not found\n", { status: 404 });
  const key = new Request("https://get.racrproto.com/__latest-provider-release");
  let tag = await (await cache?.match(key))?.text();
  if (!tag) {
    const response = await fetcher(FEED, { headers: { "User-Agent": "get.racrproto.com", Accept: "application/atom+xml" } });
    const found = response.ok ? latestTag(await response.text()) : null;
    if (!found) return new Response("No provider release is available yet; try again later.\n", { status: 503, headers: { "Retry-After": "300" } });
    tag = found;
    const stored = cache?.put(key, new Response(tag, { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } }));
    if (stored) context ? context.waitUntil(stored) : await stored;
  }
  return redirect(tag, CACHE_SECONDS);
}

export default {
  fetch(request: Request, _env: unknown, context: Context): Promise<Response> {
    return handle(request, fetch, (globalThis as unknown as { caches: { default: CacheLike } }).caches.default, context);
  },
};
