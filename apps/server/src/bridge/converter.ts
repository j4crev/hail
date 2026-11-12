import type { SQL } from "bun";
import {
  assembleBody, BridgeInputError, convertEmail, CURRENT_IMAGE_POLICY, type ImagePolicy, type RemoteImageResolver,
} from "@racrproto/email-bridge";

/** Whether the message carries a valid DKIM signature from its author's own domain. */
/** What the DKIM check concluded, and why, without message content. */
export interface DkimOutcome {
  authentication: "dkim-aligned" | "none";
  signatures: { domain: string; result: string; aligned: boolean; comment?: string }[];
  /** Why the result is "none"; also set when the check itself failed. */
  reason?: string;
  unsubscribe?: import("./unsubscribe.js").UnsubscribeTarget;
}
/** Whether the message carries a valid DKIM signature from its author's own domain. */
export type DkimCheck = (raw: Uint8Array, fromAddress: string) => Promise<DkimOutcome>;

export interface ConverterOptions {
  resolveRemote: RemoteImageResolver;
  checkDkim: DkimCheck;
  policy?: ImagePolicy;
  /** How long a claimed message is reserved before another worker may retry it. */
  leaseSeconds?: number;
  /** Attempts before a message that keeps failing is abandoned. */
  maxAttempts?: number;
}

interface Claimed { id: string; raw: Uint8Array; received_at: Date; attempts: number }

/**
 * Converts queued messages into bodies. It touches only `email_bridge_intake`,
 * so it can run under a database role that sees nothing else, and it holds no
 * keys: the provider revalidates and signs what it produces.
 */
export class EmailBridgeConverter {
  private readonly lease: number;
  private readonly maxAttempts: number;

  constructor(private readonly sql: SQL, private readonly options: ConverterOptions) {
    this.lease = options.leaseSeconds ?? 300;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  /** Converts at most one message. Returns false when nothing was ready. */
  async workOne(): Promise<boolean> {
    // A claim is a lease: a worker that dies leaves the row to be reclaimed when it lapses.
    const [claimed] = await this.sql<Claimed[]>`
      UPDATE email_bridge_intake SET state = 'converting', attempts = attempts + 1,
        next_attempt_at = clock_timestamp() + ${this.lease} * interval '1 second'
      WHERE id = (SELECT id FROM email_bridge_intake WHERE state IN ('queued','converting') AND next_attempt_at <= clock_timestamp()
        ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, raw, received_at, attempts`;
    if (!claimed) return false;
    // Every write below is conditional on the claim, so a reclaimed or deleted message is left alone.
    const raw = new Uint8Array(claimed.raw);
    try {
      const converted = await convertEmail(raw);
      const dkim = await this.options.checkDkim(raw, converted.source.fromAddress).catch((error: unknown): DkimOutcome => {
        const reason = `check failed: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : "error"}`;
        console.warn(JSON.stringify({ level: "warn", message: "email bridge DKIM check failed", reason }));
        return { authentication: "none", signatures: [], reason };
      });
      const authentication = dkim.authentication;
      const assembled = await assembleBody(converted, {
        authentication, receivedAt: Math.floor(claimed.received_at.getTime() / 1000), resolveRemote: this.options.resolveRemote,
        policy: this.options.policy ?? CURRENT_IMAGE_POLICY,
      });
      await this.sql`
        UPDATE email_bridge_intake SET state = 'converted', raw = NULL, converted_body = ${assembled.bytes},
          diagnostics = ${JSON.stringify({ ...assembled.diagnostics, dkim })}::text::jsonb, attempts = 0, next_attempt_at = clock_timestamp()
        WHERE id = ${claimed.id} AND state = 'converting' AND attempts = ${claimed.attempts}`;
    } catch (error) {
      if (error instanceof BridgeInputError || claimed.attempts >= this.maxAttempts) {
        const failure = error instanceof BridgeInputError ? `unconvertible: ${error.code}` : "conversion kept failing";
        await this.sql`UPDATE email_bridge_intake SET state = 'dead', raw = NULL, failure = ${failure} WHERE id = ${claimed.id} AND state = 'converting' AND attempts = ${claimed.attempts}`;
      } else {
        const retry = Math.min(3600, 30 * 2 ** claimed.attempts);
        await this.sql`UPDATE email_bridge_intake SET state = 'queued', next_attempt_at = clock_timestamp() + ${retry} * interval '1 second'
          WHERE id = ${claimed.id} AND state = 'converting' AND attempts = ${claimed.attempts}`;
      }
    }
    return true;
  }
}
