import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { assertWebhookUrl } from "./monitor.js";

type DnsResolver = (hostname: string, options: { all: true; verbatim: true }) =>
  Promise<readonly { address: string; family: number }[]>;

export function publicAddress(value: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.parse(value); } catch { return false; }
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
    else if (!ipv6.match(ipaddr.parse("2000::"), 3)) return false;
  }
  return parsed.range() === "unicast";
}

export class PinnedHttpsClient {
  constructor(private readonly resolve: DnsResolver = dnsLookup) {}

  post(rawUrl: string, bytes: Uint8Array, headers: Record<string, string>): Promise<Response> {
    return this.request(rawUrl, "POST", bytes, headers);
  }
  get(rawUrl: string): Promise<Response> {
    return this.request(rawUrl, "GET", undefined, {});
  }
  private async request(rawUrl: string, method: "GET" | "POST", bytes: Uint8Array | undefined,
    headers: Record<string, string>): Promise<Response> {
    const url = assertWebhookUrl(rawUrl);
    let timeout!: ReturnType<typeof setTimeout>;
    const addresses = await Promise.race([
      this.resolve(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Alert DNS lookup timed out")), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!addresses.length || addresses.some((address) => !publicAddress(address.address) ||
      (address.family !== 4 && address.family !== 6) || isIP(address.address) !== address.family)) {
      throw new Error("Alert webhook DNS is not exclusively public");
    }
    const selected = addresses[0]!;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpsRequest({ protocol: "https:", hostname: url.hostname,
        port: url.port ? Number(url.port) : 443, method, path: url.pathname,
        servername: url.hostname, agent: false, family: selected.family,
        lookup: (_host, _opts, callback) => callback(null, selected.address, selected.family),
        headers: bytes ? { ...headers, "Content-Type": "application/json", "Content-Length": String(bytes.length) } : headers,
      }, (response) => {
        let length = 0; const parts: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 4096) outgoing.destroy(new Error("Alert response exceeds its limit"));
          else parts.push(chunk);
        });
        response.on("end", () => { clearTimeout(timer); const status = response.statusCode ?? 500;
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(parts), { status })); });
        response.on("error", reject);
      });
      const timer = setTimeout(() => outgoing.destroy(new Error("Alert webhook timed out")), 10_000);
      outgoing.on("error", (error) => { clearTimeout(timer); reject(error); });
      outgoing.end(bytes);
    });
  }
}

