import {AccountApiError} from "@racrproto/client-support/account-api";
import {ClientError} from "@racrproto/client-support/client-error";

/**
 * Seconds to wait when a provider failure is temporary (rate limit, busy, or
 * unreachable), or null for any other error. Such failures are reported as 503
 * with Retry-After rather than as a server fault.
 */
export function providerBusy(cause: unknown): number | null {
  if (cause instanceof AccountApiError && (cause.status === 429 || cause.status === 503)) return Math.min(60, Math.max(1, cause.retryAfterSeconds ?? 5));
  if (cause instanceof ClientError && cause.code === "TRANSPORT_ERROR") return 5;
  return null;
}
