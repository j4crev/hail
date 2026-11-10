import ipaddr from "ipaddr.js";

// Secondary, bounded per-process abuse protection. Provider request quotas are
// independently enforced in PostgreSQL and survive process restarts.
export class SourceAdmission {
  private window = -1;
  private readonly counts = new Map<string, number>();
  take(source: string, registration: boolean, now = Date.now()): boolean {
    const window = Math.floor(now / 60_000);
    if (window !== this.window) { this.window = window; this.counts.clear(); }
    let address: string;
    try {
      const parsed = ipaddr.process(source);
      address = parsed.kind() === "ipv6"
        ? parsed.toByteArray().slice(0, 8).join(".") + "/64" : parsed.toString();
    } catch { address = "unknown"; }
    const key = (registration ? "registration:" : "enrollment:") + address;
    if (!this.counts.has(key) && this.counts.size >= 10_000) return false;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= (registration ? 5 : 120);
  }
}
