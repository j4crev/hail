import type { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";
import { decodeBase64Url } from "@racrproto/codec/base64url";
import { assertWebhookUrl } from "./monitor.js";
import { hash } from "./http.js";

export interface EnrollmentProvider {
  id: string;
  provider_origin: string;
  alert_origin: string;
  requests_per_minute: number;
  max_identities: number;
  enrollments_per_day: number;
}
export class ProviderAdmissionError extends Error {
  constructor(readonly status: 401 | 403 | 409 | 429, message: string) { super(message); }
}
export function canonicalOrigin(value: string): string {
  if (assertWebhookUrl(value).origin !== value) throw new Error("Use a canonical HTTPS origin");
  return value;
}
export class EnrollmentProviders {
  constructor(readonly sql: SQL) {}
  async create(providerOrigin: string, alertOrigin: string, token = randomBytes(32).toString("base64url")) {
    canonicalOrigin(providerOrigin); canonicalOrigin(alertOrigin); decodeBase64Url(token, 32);
    const id = randomUUID();
    await this.sql`INSERT INTO monitor_enrollment_providers(id,provider_origin,alert_origin,token_hash)
      VALUES (${id},${providerOrigin},${alertOrigin},${await hash(token)})`;
    return { id, token, providerOrigin, alertOrigin };
  }
  async rotate(id: string) {
    const token = randomBytes(32).toString("base64url");
    const rows = await this.sql`UPDATE monitor_enrollment_providers SET token_hash=${await hash(token)}
      WHERE id=${id} RETURNING id`;
    if (!rows.length) throw new Error("Unknown provider");
    return { id, token };
  }
  async setEnabled(id: string, enabled: boolean) {
    if (!(await this.sql`UPDATE monitor_enrollment_providers SET enabled=${enabled} WHERE id=${id} RETURNING id`).length)
      throw new Error("Unknown provider");
    // Existing monitoring and notification delivery do not depend on this flag.
  }
  async authenticate(request: Request): Promise<EnrollmentProvider> {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) throw new ProviderAdmissionError(401, "Unauthorized enrollment");
    return this.sql.begin(async tx => {
      const provider = (await tx<(EnrollmentProvider & { enabled: boolean })[]>`SELECT *
        FROM monitor_enrollment_providers WHERE token_hash=${await hash(token)} FOR UPDATE`)[0];
      if (!provider) throw new ProviderAdmissionError(401, "Unauthorized enrollment");
      if (!provider.enabled) throw new ProviderAdmissionError(403, "Provider enrollment disabled");
      const rows = await tx`UPDATE monitor_enrollment_providers SET
        request_count=CASE WHEN request_window=date_trunc('minute',clock_timestamp()) THEN request_count+1 ELSE 1 END,
        request_window=date_trunc('minute',clock_timestamp())
        WHERE id=${provider.id} AND (request_window IS DISTINCT FROM date_trunc('minute',clock_timestamp())
          OR request_count<requests_per_minute) RETURNING id`;
      if (!rows.length) throw new ProviderAdmissionError(429, "Provider request limit reached");
      return provider;
    });
  }
}
