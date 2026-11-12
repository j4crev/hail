// Monitor → shared receiver messages (spec/monitor-receiver.md). Pure, so the
// Cloudflare receiver imports the same checks the monitor signs against.

export const RECEIVER_PROVIDER_PATH = "/hail/providers";
export const RECEIVER_PROVIDER_CONTEXT = "hail.plc-monitor-receiver-provider.v1\0";
export const OPERATOR_VERIFICATION_PATH = "/hail/operator-verification";
export const OPERATOR_VERIFICATION_CONTEXT = "hail.plc-monitor-operator-verification.v1\0";

export interface ReceiverProviderRecord {
  type: "hail.plc-monitor-receiver-provider"; version: 1;
  providerId: string; providerOrigin: string; webOrigin: string | null;
  tokenHash: string; enabled: boolean; issuedAt: number;
}
export interface OperatorVerification {
  type: "hail.plc-monitor-operator-verification"; version: 1;
  email: string; code: string; providerOrigin: string; expiresAt: number; issuedAt: number;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** A canonical HTTPS DNS origin on port 443, without credentials, path, query or fragment. */
export function httpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 260) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port &&
      !/^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && url.hostname.includes(".");
  } catch { return false; }
}

/** Normalizes an operator or user email address; null when unacceptable. */
export function emailAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts as [string, string], domain = rawDomain.toLowerCase();
  if (!local || local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    domain.length > 253 || !domain.includes(".") ||
    domain.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    !/^[a-z]{2,63}$/.test(domain.split(".").at(-1)!)) return null;
  return `${local}@${domain}`;
}

function fresh(issuedAt: unknown, now: number): boolean {
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && Math.abs(issuedAt - now) <= 300;
}

export function checkReceiverProviderRecord(value: unknown, now: number): asserts value is ReceiverProviderRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid provider record");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "enabled,issuedAt,providerId,providerOrigin,tokenHash,type,version,webOrigin" ||
    row.type !== "hail.plc-monitor-receiver-provider" || row.version !== 1 ||
    typeof row.providerId !== "string" || !UUID.test(row.providerId) || !httpsOrigin(row.providerOrigin) ||
    row.webOrigin !== null && !httpsOrigin(row.webOrigin) || typeof row.enabled !== "boolean" ||
    typeof row.tokenHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.tokenHash) || !fresh(row.issuedAt, now))
    throw Error("Invalid provider record");
}

export function checkOperatorVerification(value: unknown, now: number): asserts value is OperatorVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid operator verification");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "code,email,expiresAt,issuedAt,providerOrigin,type,version" ||
    row.type !== "hail.plc-monitor-operator-verification" || row.version !== 1 ||
    emailAddress(row.email) !== row.email || typeof row.code !== "string" || !/^\d{8}$/.test(row.code) ||
    !httpsOrigin(row.providerOrigin) || typeof row.expiresAt !== "number" || !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt <= now || row.expiresAt > now + 900 || !fresh(row.issuedAt, now))
    throw Error("Invalid operator verification");
}
