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
      WHERE id=${id} AND retired_at IS NULL RETURNING id`;
    if (!rows.length) throw new Error("Unknown provider");
    return { id, token };
  }
  /** The record the shared receiver holds for this provider; null before it has a receiver credential. */
  async receiverRecord(id: string) {
    const row = (await this.sql<{ id: string; provider_origin: string; web_origin: string | null; receiver_token_hash: string | null;
      enabled: boolean; retired_at: Date | null }[]>`SELECT id,provider_origin,web_origin,receiver_token_hash,enabled,retired_at
      FROM monitor_enrollment_providers WHERE id=${id}`)[0];
    if (!row) throw new Error("Unknown provider");
    if (!row.receiver_token_hash) return null;
    return { providerId: row.id, providerOrigin: row.provider_origin, webOrigin: row.web_origin,
      tokenHash: row.receiver_token_hash, enabled: row.enabled && !row.retired_at };
  }
  async markProvisioned(id: string) {
    await this.sql`UPDATE monitor_enrollment_providers SET receiver_provisioned_at=clock_timestamp() WHERE id=${id}`;
  }
  /** Adopts a provider's existing receiver secret (pre-v2 migration). Only its hash is kept. */
  async importReceiver(id: string, secret: string, webOrigin: string | null) {
    decodeBase64Url(secret, 32);
    if (webOrigin !== null) canonicalOrigin(webOrigin);
    const rows = await this.sql`UPDATE monitor_enrollment_providers SET receiver_token_hash=${await hash(secret)},
      web_origin=${webOrigin},receiver_provisioned_at=NULL WHERE id=${id} AND retired_at IS NULL AND receiver_token_hash IS NULL RETURNING id`;
    if (!rows.length) throw new Error("Unknown provider, or it already has a receiver credential");
  }
  async rotateReceiver(id: string) {
    const token = randomBytes(32).toString("base64url");
    const rows = await this.sql`UPDATE monitor_enrollment_providers SET receiver_token_hash=${await hash(token)},receiver_provisioned_at=NULL
      WHERE id=${id} AND retired_at IS NULL RETURNING id`;
    if (!rows.length) throw new Error("Unknown provider");
    return { id, receiverToken: token };
  }
  async setEnabled(id: string, enabled: boolean) {
    if (!(await this.sql`UPDATE monitor_enrollment_providers SET enabled=${enabled} WHERE id=${id} AND retired_at IS NULL RETURNING id`).length)
      throw new Error("Unknown provider");
    // Existing monitoring and notification delivery do not depend on this flag.
  }
  async retire(id: string, expectedActive: number): Promise<number> {
    if (!Number.isSafeInteger(expectedActive) || expectedActive < 0) throw Error("Expected active count required");
    return this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(686169156)`;
      const provider = (await tx`SELECT id FROM monitor_enrollment_providers WHERE id=${id} FOR UPDATE`)[0];
      if (!provider) throw Error("Unknown provider");
      const rows = await tx`SELECT did FROM monitored_dids WHERE enrollment_provider_id=${id} AND stopped_at IS NULL ORDER BY did FOR UPDATE`;
      if (rows.length !== expectedActive) throw Error("Active enrollment count changed; review before retiring");
      await tx`UPDATE monitor_enrollment_providers SET enabled=false,retired_at=coalesce(retired_at,clock_timestamp()) WHERE id=${id}`;
      await tx`INSERT INTO monitor_receiver_cleanup(did,operation_cid,receiver_url)
        SELECT w.did,b.operation_cid,w.alert_webhook_url FROM monitored_dids w
        JOIN monitor_bootstrap_checkpoints b ON b.did=w.did
        WHERE w.enrollment_provider_id=${id} AND w.stopped_at IS NULL ON CONFLICT(did) DO NOTHING`;
      await tx`UPDATE monitored_dids SET stopped_at=coalesce(stopped_at,clock_timestamp()),poll_ready=false
        WHERE enrollment_provider_id=${id}`;
      await tx`UPDATE monitor_alerts SET lease_token=NULL,lease_expires_at=NULL
        WHERE sent_at IS NULL AND did IN (SELECT did FROM monitored_dids WHERE enrollment_provider_id=${id})`;
      return rows.length;
    });
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
