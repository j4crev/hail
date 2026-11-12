import {AsyncLocalStorage} from "node:async_hooks";
import {isIP} from "node:net";

const addresses = new AsyncLocalStorage<string | null>();

/**
 * Runs one GUI request with its browser's address, as Caddy sets it from tunnel
 * metadata (GUI ingress is private). Server-side provider calls forward it so the
 * provider's per-client limits apply to each user, not to the GUI as a whole.
 */
export function withClientAddress<T>(request: Request, operation: () => T): T {
  const value = request.headers?.get("X-Hail-Trusted-Client-IP");
  return addresses.run(value && isIP(value) ? value : null, operation);
}
export function clientAddress(): string | null {
  return addresses.getStore() ?? null;
}
