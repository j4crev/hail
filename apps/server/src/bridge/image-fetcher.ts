import type { RemoteImageResolver } from "@racrproto/email-bridge";
import type { DiscoveryFetch } from "../discovery/verifier.js";

export interface ImageFetchLimits {
  /** Redirect hops followed for one image. */
  maxRedirects: number;
  /** Time allowed for one image, including its redirects and body. */
  perImageMs: number;
}
export const DEFAULT_IMAGE_FETCH_LIMITS: ImageFetchLimits = { maxRedirects: 3, perImageMs: 15_000 };

/**
 * Image hosts refuse bare requests and offer WebP to anything that does not say
 * otherwise. Measured on real newsletters: a browser-style User-Agent cut refusals
 * from 24 to 6 of 509 images, and asking only for PNG and JPEG stopped WebP answers.
 * The User-Agent names the bridge so a host can tell what is fetching.
 */
const HEADERS = {
  Accept: "image/png,image/jpeg;q=0.9,image/*;q=0.5",
  "User-Agent": "Mozilla/5.0 (compatible; HailEmailBridge/1; +https://racrproto.com/email-bridge)",
};

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/**
 * Fetches a remote image for the converter. Every hop, including each redirect
 * target, goes through the safe transport: HTTPS on port 443, public addresses
 * only, no credentials or cookies. Any failure yields null, which the converter
 * turns into a link.
 */
export function createImageResolver(fetchImage: DiscoveryFetch, limits: ImageFetchLimits = DEFAULT_IMAGE_FETCH_LIMITS): RemoteImageResolver {
  return async (start, maxBytes) => {
    if (maxBytes < 1) return null;
    const signal = AbortSignal.timeout(limits.perImageMs);
    let url: URL;
    try { url = new URL(start); } catch { return null; }
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      let response: Response;
      try { response = await fetchImage(new Request(url, { method: "GET", headers: HEADERS, signal })); }
      catch { return null; }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return null;
        try { url = new URL(location, url); } catch { return null; }
        if (url.protocol !== "https:") return null;
        url.hash = "";
        continue;
      }
      if (response.status !== 200) { await response.body?.cancel(); return null; }
      try { return await readBounded(response, maxBytes, signal); } catch { return null; }
    }
    return null;
  };
}
