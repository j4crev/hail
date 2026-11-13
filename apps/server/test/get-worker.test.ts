import { expect, it, vi } from "vitest";
import { handle, latestTag } from "../../hailctl/deploy/get-worker/worker.js";

const feed = (tags: string[]) => `<feed>${tags.map(tag => `<entry><link rel="alternate" type="text/html" href="https://github.com/j4crev/hail/releases/tag/${tag}"/></entry>`).join("")}</feed>`;

it("picks the highest provider release that ships the installer, ignoring other tags", () => {
  expect(latestTag(feed(["cli-v9.0.0", "provider-v0.10.0", "provider-v0.9.3", "v9.9.9", "provider-v0.1.0"]))).toBe("provider-v0.10.0");
  expect(latestTag(feed(["provider-v0.1.0", "provider-v0.2.0", "provider-v0.3.0", "cli-v1.0.0"]))).toBeNull(); // no supported installer before 0.4.0
  expect(latestTag(feed(["provider-v01.2.0", "provider-v1.2"]))).toBeNull();
});

it("redirects to the release's install.sh and caches the choice", async () => {
  const stored = new Map<string, string>();
  const cache = { match: vi.fn(async (r: Request) => stored.has(r.url) ? new Response(stored.get(r.url)) : undefined),
    put: vi.fn(async (r: Request, response: Response) => { stored.set(r.url, await response.text()); }) };
  const fetcher = vi.fn(async () => new Response(feed(["provider-v0.4.0", "provider-v0.4.1"]))) as unknown as typeof fetch;
  for (const path of ["/", "/install.sh"]) {
    const response = await handle(new Request(`https://get.racrproto.com${path}`), fetcher, cache);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://github.com/j4crev/hail/releases/download/provider-v0.4.1/install.sh");
  }
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await handle(new Request("https://get.racrproto.com/other"), fetcher, cache)).status).toBe(404);
  expect((await handle(new Request("https://get.racrproto.com/", { method: "POST" }), fetcher, cache)).status).toBe(405);
});

it("redirects a pinned release without reading the feed", async () => {
  const fetcher = vi.fn() as unknown as typeof fetch;
  const response = await handle(new Request("https://get.racrproto.com/provider-v0.4.0"), fetcher);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://github.com/j4crev/hail/releases/download/provider-v0.4.0/install.sh");
  for (const old of ["provider-v0.1.0", "provider-v0.2.0", "provider-v0.3.0"]) {
    expect((await handle(new Request(`https://get.racrproto.com/${old}`), fetcher)).status).toBe(404); // no working installer
  }
  for (const path of ["/provider-v0.4", "/provider-v00.4.0", "/provider-v0.4.0/x", "/cli-v1.0.0"]) {
    expect((await handle(new Request(`https://get.racrproto.com${path}`), fetcher)).status, path).toBe(404);
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("fails closed when no usable release is published", async () => {
  const response = await handle(new Request("https://get.racrproto.com/"), (async () => new Response(feed(["provider-v0.1.0"]))) as unknown as typeof fetch);
  expect(response.status).toBe(503);
  expect((await handle(new Request("https://get.racrproto.com/"), (async () => new Response("", { status: 500 })) as unknown as typeof fetch)).status).toBe(503);
});
