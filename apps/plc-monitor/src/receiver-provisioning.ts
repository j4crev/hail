import { encodeBase64Url } from "@racrproto/codec/base64url";
import { PinnedHttpsClient } from "./public-http.js";
import { OPERATOR_VERIFICATION_PATH, RECEIVER_PROVIDER_PATH, httpsOrigin,
  type OperatorVerification, type ReceiverProviderRecord } from "./receiver-provider-wire.js";
import type { MonitorSigner } from "./signing.js";

export type ProvisionedProvider = Omit<ReceiverProviderRecord, "type" | "version" | "issuedAt">;

/** Signed monitor requests to the shared receiver (spec/monitor-receiver.md). */
export class ReceiverClient {
  constructor(private readonly signer: MonitorSigner, readonly origin: string,
    private readonly http: Pick<PinnedHttpsClient, "post"> = new PinnedHttpsClient()) {
    if (!httpsOrigin(origin)) throw new Error("MONITOR_RECEIVER_ORIGIN must be a canonical HTTPS origin");
  }

  async provision(provider: ProvisionedProvider): Promise<void> {
    const record: ReceiverProviderRecord = { type: "hail.plc-monitor-receiver-provider", version: 1, ...provider,
      issuedAt: Math.floor(Date.now() / 1000) };
    await this.send(RECEIVER_PROVIDER_PATH, record, bytes => this.signer.signReceiverProvider(bytes));
  }

  async verifyOperator(email: string, code: string, providerOrigin: string, expiresAt: number): Promise<void> {
    const request: OperatorVerification = { type: "hail.plc-monitor-operator-verification", version: 1, email, code,
      providerOrigin, expiresAt, issuedAt: Math.floor(Date.now() / 1000) };
    await this.send(OPERATOR_VERIFICATION_PATH, request, bytes => this.signer.signOperatorVerification(bytes));
  }

  private async send(path: string, value: unknown, sign: (bytes: Uint8Array) => Uint8Array): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const response = await this.http.post(this.origin + path, bytes, { "Content-Type": "application/json",
      "X-Hail-Monitor-Key": this.signer.publicDidKey, "X-Hail-Monitor-Signature": encodeBase64Url(sign(bytes)) });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error("Receiver refused the monitor request");
  }
}
