import { PinnedHttpsClient } from "./public-http.js";
import type { IncidentCapabilities } from "./incident-capabilities.js";
import type { SQL } from "bun";
import { encodeBase64Url } from "@racrproto/codec";
import type { MonitorSigner } from "./signing.js";

export interface AlertTransport {
  send(url: string, bytes: Uint8Array, signature: Uint8Array, signer: string): Promise<number>;
}

export { publicAddress } from "./public-http.js";
export class PinnedHttpsAlertTransport implements AlertTransport {
  private readonly client: PinnedHttpsClient;
  constructor(resolve?: ConstructorParameters<typeof PinnedHttpsClient>[0]) {
    this.client = new PinnedHttpsClient(resolve);
  }
  async send(url: string, bytes: Uint8Array, signature: Uint8Array, signer: string): Promise<number> {
    const response = await this.client.post(url, bytes, {
      "X-Hail-Monitor-Key": signer, "X-Hail-Monitor-Signature": encodeBase64Url(signature),
    });
    await response.body?.cancel();
    return response.status;
  }
}

interface AlertRow {
  id: string;
  did: string;
  category: string;
  detail: unknown;
  created_at: Date;
  alert_webhook_url: string;
  attempt_count: number;
}

export class MonitorNotifier {
  constructor(private readonly sql: SQL, private readonly signer: MonitorSigner,
    private readonly transport: AlertTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly incidents?: IncidentCapabilities) {}

  async sendOne(): Promise<"idle" | "sent" | "retry"> {
    const token = crypto.randomUUID();
    const claim = await this.sql.begin(async (tx) => {
      const rows = await tx<AlertRow[]>`
        SELECT alert.id, alert.did, alert.category, alert.detail, alert.created_at,
          account.alert_webhook_url, alert.attempt_count
        FROM monitor_alerts alert JOIN monitored_dids account ON account.did = alert.did
        WHERE account.stopped_at IS NULL AND alert.sent_at IS NULL AND alert.next_attempt_at <= now()
          AND (alert.lease_expires_at IS NULL OR alert.lease_expires_at <= now())
        ORDER BY alert.next_attempt_at FOR UPDATE OF alert SKIP LOCKED LIMIT 1
      `;
      if (!rows[0]) return null;
      await tx`UPDATE monitor_alerts SET lease_token = ${token},
        lease_expires_at = now() + interval '30 seconds', attempt_count = attempt_count + 1
        WHERE id = ${rows[0].id}`;
      return rows[0];
    });
    if (!claim) return "idle";
    try {
      const detail = typeof claim.detail === "string" ? JSON.parse(claim.detail) as unknown : claim.detail;
      const payload = JSON.stringify({ type: "hail.plc-monitor-alert", version: 1, id: claim.id,
        did: claim.did, category: claim.category, detail: this.incidents && claim.category !== "onboarding-enrollment"
          ? { ...(detail as object), review: await this.incidents.issue(claim) } : detail,
        occurred_at: claim.created_at.toISOString() });
      const bytes = new TextEncoder().encode(payload);
      const status = await this.transport.send(claim.alert_webhook_url, bytes,
        this.signer.signAlert(bytes), this.signer.publicDidKey);
      if (status >= 200 && status < 300) {
        await this.sql`UPDATE monitor_alerts SET sent_at = ${this.now()}, lease_token = NULL,
          lease_expires_at = NULL WHERE id = ${claim.id} AND lease_token = ${token}`;
        return "sent";
      }
    } catch { /* Persist responsibility and retry on network failure. */ }
    const delay = Math.min(3600, 30 * 2 ** Math.min(claim.attempt_count, 7));
    await this.sql`UPDATE monitor_alerts SET next_attempt_at = ${new Date(this.now().getTime() + delay * 1000)},
      lease_token = NULL, lease_expires_at = NULL WHERE id = ${claim.id} AND lease_token = ${token}`;
    return "retry";
  }
}
