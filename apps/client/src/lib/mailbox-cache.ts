/** Browser-owned instances only. Never stores credentials or persists mailbox content. */
export class MailboxCache {
  private entries = new Map<string, {data:unknown; size:number; time:number}>();
  private pending = new Map<string, Promise<unknown>>();
  private size = 0;
  generation = 0;
  mutations = 0;
  private idleWaiters = new Set<()=>void>();
  beginMutation() {this.mutations++; this.clear();}
  endMutation() {
    this.mutations--; this.clear();
    if (!this.mutations) {for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear();}
  }
  async idle() {if (this.mutations) await new Promise<void>(resolve=>this.idleWaiters.add(resolve));}
  constructor(private limit = 8_000_000, private count = 16) {}
  clear() { this.generation++; this.entries.clear(); this.pending.clear(); this.size = 0; }
  get<T>(key:string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (Date.now() - entry.time > 300_000) {this.entries.delete(key); this.size -= entry.size; return;}
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.data as T;
  }
  async request<T>(key:string, read:()=>Promise<T>):Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const generation = this.generation;
    const pending = read().then(data => {
      if (generation !== this.generation || this.mutations) throw new StaleMailboxRead();
      const size = JSON.stringify(data).length * 2;
      const old = this.entries.get(key);
      if (old) {this.size -= old.size; this.entries.delete(key);}
      if (size <= this.limit) {
        this.entries.set(key, {data, size, time:Date.now()}); this.size += size;
        while (this.size > this.limit || this.entries.size > this.count) {
          const first = this.entries.keys().next().value!;
          this.size -= this.entries.get(first)!.size; this.entries.delete(first);
        }
      }
      return data;
    }).finally(() => {if (this.pending.get(key) === pending) this.pending.delete(key);});
    this.pending.set(key, pending);
    return pending;
  }
}
export class StaleMailboxRead extends Error {}
export const mailboxCache = new MailboxCache();
