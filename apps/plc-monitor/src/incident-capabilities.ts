import type { SQL } from 'bun';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from './http.js';
import { assertWebhookUrl } from './monitor.js';
import type { MonitorSigner } from './signing.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const INCIDENT_LINK_MS = 24 * 3600_000;
export const INCIDENT_SESSION_MS = 30 * 60_000;
export const INCIDENT_RENEW_MS = 30 * 86400_000;
export class IncidentCapabilities {
  constructor(readonly sql: SQL, private readonly signer: MonitorSigner, readonly origin: string) {
    if (assertWebhookUrl(origin).origin !== origin) throw new Error('Incident origin must be a canonical HTTPS origin');
  }
  async issue(alert: { id: string; created_at: Date }) {
    const token = this.signer.incidentToken(alert.id), expires = new Date(alert.created_at.getTime() + INCIDENT_LINK_MS);
    await this.sql`INSERT INTO monitor_incident_capabilities(alert_id,token_hash,expires_at)
      VALUES (${alert.id},${await hash(token)},${expires}) ON CONFLICT (alert_id) DO NOTHING`;
    return { url: `${this.origin}/incidents/${alert.id}?token=${token}`, expiresAt: expires.toISOString() };
  }
  async redeem(alertId: string, token: string): Promise<string | null> {
    if (!TOKEN.test(token)) return null;
    const session = randomBytes(32).toString('base64url');
    return this.sql.begin(async tx => {
      const rows = await tx`UPDATE monitor_incident_capabilities c SET consumed_at=clock_timestamp()
        FROM monitor_alerts a, monitored_dids w
        WHERE c.alert_id=${alertId} AND c.token_hash=${await hash(token)} AND c.alert_id=a.id AND a.did=w.did
          AND c.expires_at>clock_timestamp() AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND w.stopped_at IS NULL
        RETURNING c.alert_id`;
      if (!rows.length) return null;
      await tx`DELETE FROM monitor_incident_sessions WHERE expires_at<=clock_timestamp()`;
      await tx`INSERT INTO monitor_incident_sessions(token_hash,alert_id,expires_at)
        VALUES (${await hash(session)},${alertId},clock_timestamp()+interval '30 minutes')`;
      return session;
    });
  }
  async authorized(alertId: string, session: string): Promise<boolean> {
    if (!TOKEN.test(session)) return false;
    return Boolean((await this.sql`SELECT s.alert_id FROM monitor_incident_sessions s
      JOIN monitor_incident_capabilities c ON c.alert_id=s.alert_id
      JOIN monitor_alerts a ON a.id=c.alert_id JOIN monitored_dids w ON w.did=a.did
      WHERE s.alert_id=${alertId} AND s.token_hash=${await hash(session)} AND s.expires_at>clock_timestamp()
        AND c.revoked_at IS NULL AND w.stopped_at IS NULL`)[0]);
  }
  // A used/expired link can request a replacement at the original destination.
  // It grants no session; never accepts a caller-selected email or webhook.
  async renew(alertId: string, token: string): Promise<void> {
    if (!TOKEN.test(token)) return;
    await this.sql.begin(async tx => {
      const row = (await tx`SELECT a.did,a.category,a.detail FROM monitor_incident_capabilities c
        JOIN monitor_alerts a ON a.id=c.alert_id JOIN monitored_dids w ON w.did=a.did
        WHERE c.alert_id=${alertId} AND c.token_hash=${await hash(token)} AND c.revoked_at IS NULL AND w.stopped_at IS NULL
          AND a.created_at>clock_timestamp()-interval '30 days'
          AND (c.renewed_at IS NULL OR c.renewed_at<clock_timestamp()-interval '1 hour')
        FOR UPDATE OF c,w`)[0];
      if (!row) return;
      // Also bound all renewal links for the same DID, including a renewal of a renewal.
      if ((await tx`SELECT id FROM monitor_alerts WHERE did=${row.did} AND correlation LIKE 'incident-renewal:%'
        AND created_at>clock_timestamp()-interval '1 hour' LIMIT 1`).length) return;
      const id = randomUUID();
      await tx`INSERT INTO monitor_alerts(id,did,category,correlation,detail)
        VALUES (${id},${row.did},${row.category},${`incident-renewal:${id}`},${JSON.stringify(typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail)}::jsonb)`;
      await tx`UPDATE monitor_incident_capabilities SET renewed_at=clock_timestamp() WHERE alert_id=${alertId}`;
    });
  }
}
