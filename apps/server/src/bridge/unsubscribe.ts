import { createHash, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import type { DiscoveryFetch } from "../discovery/verifier.js";
import { SafeHttpsTransport } from "../discovery/safe-fetch.js";

export interface UnsubscribeTarget { listKey: string; url: string }
const transport = new SafeHttpsTransport();
export function validUnsubscribeUrl(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096) return false;
  try {
    const url = new URL(value);
    transport.validateTarget(url);
    return !url.hostname.includes(":") && (!url.port || url.port === "443");
  } catch { return false; }
}

/** Use only the actual headers covered by one passing, aligned DKIM signature. */
export function unsubscribeTarget(raw: Uint8Array, domain: string, signed: readonly string[]): UnsubscribeTarget | undefined {
  const text = Buffer.from(raw.subarray(0, 65_536)).toString("latin1"), end = text.indexOf("\r\n\r\n");
  if (end < 0) return;
  const headers = text.slice(0, end).replace(/\r\n[ \t]+/g, " ").split("\r\n");
  const values = (lines: readonly string[], name: string) => lines.filter(line => line.slice(0, line.indexOf(":")).toLowerCase() === name)
    .map(line => line.slice(line.indexOf(":") + 1).replace(/\r\n[ \t]+/g, " ").trim());
  const get = (name: string) => {
    const all = values(headers, name), covered = values(signed, name);
    return all.length === 1 && covered.length === 1 && all[0] === covered[0] ? all[0] : undefined;
  };
  if (get("list-unsubscribe-post") !== "List-Unsubscribe=One-Click") return;
  const header = get("list-unsubscribe");
  if (!header) return;
  // Accept standard bracketed URI lists, never scrape links from message content.
  const uris = header.split(",").map(part => /^\s*<([^<>\s]+)>\s*$/.exec(part)?.[1]);
  if (uris.some(uri => !uri)) return;
  const https = uris.filter(uri => uri!.startsWith("https://"));
  if (https.length !== 1 || !validUnsubscribeUrl(https[0])) return;
  const url = https[0];
  const list = get("list-id")?.match(/<([^<>\s]{1,255})>\s*$/)?.[1];
  // Without an authenticated list ID, keep distinct URLs rather than conflating lists.
  return { listKey: createHash("sha256").update(`${domain.toLowerCase()}\n${list ? `list:${list}` : `url:${url}`}`).digest("hex"), url };
}

/** Called inside alias deletion's transaction, after fencing off the alias. */
export async function queueUnsubscriptions(sql: SQL, aliasId: string): Promise<number> {
  const rows = await sql<{ target: unknown }[]>`
    SELECT DISTINCT ON (diagnostics #>> '{dkim,unsubscribe,listKey}') diagnostics #> '{dkim,unsubscribe}' AS target
    FROM email_bridge_intake WHERE alias_id = ${aliasId} AND diagnostics #>> '{dkim,authentication}' = 'dkim-aligned' AND diagnostics #>> '{dkim,unsubscribe,listKey}' IS NOT NULL
    ORDER BY diagnostics #>> '{dkim,unsubscribe,listKey}', accepted_at DESC, id DESC LIMIT 100`;
  let queued = 0;
  const urls = new Set<string>();
  for (const { target } of rows) {
    if (!target || typeof target !== "object") continue;
    const { listKey, url } = target as Partial<UnsubscribeTarget>;
    if (typeof listKey !== "string" || !/^[a-f0-9]{64}$/.test(listKey) || !validUnsubscribeUrl(url) || urls.has(url)) continue;
    urls.add(url);
    await sql`INSERT INTO email_bridge_unsubscriptions(id, alias_id, url) VALUES (${randomUUID()}, ${aliasId}, ${url})`;
    queued++;
  }
  return queued;
}

/** Best effort, bounded, at-least-once POSTs. Completion never gates alias deletion. */
export class EmailBridgeUnsubscriber {
  constructor(private readonly sql: SQL, private readonly fetch: DiscoveryFetch = transport.fetch) {}
  async workOne(): Promise<boolean> {
    const [job] = await this.sql<{ id: string; url: string; attempts: number }[]>`
      UPDATE email_bridge_unsubscriptions SET attempts = attempts + 1, next_attempt_at = clock_timestamp() + interval '1 minute'
      WHERE id = (SELECT id FROM email_bridge_unsubscriptions WHERE state = 'queued' AND next_attempt_at <= clock_timestamp()
        ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id, url, attempts`;
    if (!job) return false;
    let requested = false, retry = false;
    if (job.attempts <= 5 && validUnsubscribeUrl(job.url)) {
      try {
        const response = await this.fetch(new Request(job.url, {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), credentials: "omit",
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
        }));
        requested = response.status >= 200 && response.status < 300;
        retry = response.status === 429 || response.status >= 500;
        // No response content is needed; never follow redirects or retain cookies.
        await response.body?.cancel();
      } catch { retry = true; /* Never log a URL/token or a fetch error containing one. */ }
    }
    if (retry && job.attempts < 5) {
      const delay = Math.min(3600, 60 * 2 ** job.attempts);
      await this.sql`UPDATE email_bridge_unsubscriptions SET next_attempt_at = clock_timestamp() + ${delay} * interval '1 second'
        WHERE id = ${job.id} AND state = 'queued' AND attempts = ${job.attempts}`;
    } else {
      await this.sql`UPDATE email_bridge_unsubscriptions SET state = ${requested ? "requested" : "failed"}, url = NULL
        WHERE id = ${job.id} AND state = 'queued' AND attempts = ${job.attempts}`;
    }
    return true;
  }
}
