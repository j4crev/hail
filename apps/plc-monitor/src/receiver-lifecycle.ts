import type { SQL } from "bun";
import { RECEIVER_LIFECYCLE_PATH, type ReceiverLifecycle } from "./receiver-lifecycle-wire.js";
import { encodeBase64Url } from "@racrproto/codec/base64url";
import type { MonitorSigner } from "./signing.js";
import { PinnedHttpsClient } from "./public-http.js";

export class ReceiverLifecycleClient {
  constructor(private readonly signer: MonitorSigner, private readonly http = new PinnedHttpsClient()) {}
  async send(receiver: string, did: string, operationCid: string, action: "claim" | "stop"): Promise<void> {
    if (new URL(receiver).pathname !== "/hail/signup") throw Error("Receiver does not support managed lifecycle");
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "hail.plc-monitor-receiver-lifecycle", version: 1,
      did, operationCid, action, issuedAt: Math.floor(Date.now() / 1000) } satisfies ReceiverLifecycle));
    const response = await this.http.post(new URL(RECEIVER_LIFECYCLE_PATH, receiver).href, bytes, {
      "Content-Type": "application/json", "X-Hail-Monitor-Key": this.signer.publicDidKey,
      "X-Hail-Monitor-Signature": encodeBase64Url(this.signer.signReceiverLifecycle(bytes)),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw Error("Receiver lifecycle request refused");
  }
}
export async function cleanMonitorReceiver(sql: SQL, client: Pick<ReceiverLifecycleClient, "send">) {
  return sql.begin(async tx => {
    const row = (await tx`SELECT * FROM monitor_receiver_cleanup WHERE completed_at IS NULL
      AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,did FOR UPDATE SKIP LOCKED LIMIT 1`)[0];
    if (!row) return "idle";
    try {
      await client.send(row.receiver_url, row.did, row.operation_cid, "stop");
      await tx`UPDATE monitor_receiver_cleanup SET completed_at=clock_timestamp(),attempt_count=attempt_count+1 WHERE did=${row.did}`;
      return "completed";
    } catch {
      const seconds = Math.min(3600, 15 * 2 ** Math.min(Number(row.attempt_count), 8));
      await tx`UPDATE monitor_receiver_cleanup SET attempt_count=attempt_count+1,
        next_attempt_at=clock_timestamp()+${seconds}*interval '1 second' WHERE did=${row.did}`;
      return "retry";
    }
  });
}
