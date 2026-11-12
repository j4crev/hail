import { discoverProvider, type ProviderDiscovery } from "../discovery/delegation.js";
import { canonicalizeHailAddress } from "../identity/address.js";

/** A canonical public DNS name usable as a native address domain: no port, path or address literal. */
export function isCanonicalAddressDomain(domain: unknown): domain is string {
  if (typeof domain !== "string" || domain.includes(":") || domain.includes("/")) return false;
  try { return canonicalizeHailAddress(`a@${domain}`) === `a@${domain}`; } catch { return false; }
}

/**
 * The destination address domain is served by the destination service base when
 * it is that exact host, or when `_hail-provider.{domain}` delegates to that host.
 * Sources check this before acknowledging a user-signed transfer grant.
 */
export async function assertDestinationDomain(domain: string, serviceBase: string,
  discover: ProviderDiscovery = discoverProvider): Promise<void> {
  if (!isCanonicalAddressDomain(domain)) throw new Error("Transfer destination domain is not canonical");
  const host = new URL(serviceBase).hostname;
  if (domain === host) return;
  let delegated: string | null;
  try { delegated = await discover(domain, AbortSignal.timeout(10_000)); }
  catch { throw new Error("Transfer destination domain delegation is unavailable"); }
  if (delegated !== host) throw new Error("Transfer destination domain is not delegated to the destination provider");
}

/** Provider-to-provider transfer endpoints live at the service base's origin, never the address domain. */
export function transferEndpoint(serviceBase: string, operation: string): URL {
  return new URL(`/.well-known/hail/transfers/${operation}`, new URL(serviceBase).origin);
}
