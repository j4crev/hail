import type { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ALIAS_LOCAL_PART } from "./aliases.js";

/**
 * What the mail edge should do with a message, in terms it can express in SMTP:
 * accept it, refuse it permanently, or ask the sender to retry later. The reason
 * for a refusal is deliberately not part of the answer.
 */
export type IntakeDecision = "accept" | "reject" | "defer";
export type SubmitResult = "accepted" | "duplicate" | "reject" | "defer";

export interface IntakeLimits {
  maxMessageBytes: number;
  /** Messages accepted for one alias in any hour. */
  aliasHourly: number;
  /** Messages accepted for one account in any day. */
  accountDaily: number;
  /** Original messages awaiting conversion for one account. */
  accountPendingBytes: number;
}
export const DEFAULT_INTAKE_LIMITS: IntakeLimits = {
  maxMessageBytes: 10 * 1024 * 1024, aliasHourly: 30, accountDaily: 300, accountPendingBytes: 64 * 1024 * 1024,
};

export interface IntakeMessage {
  recipient: string;
  raw: Uint8Array;
  /** SMTP envelope sender, when the edge knows it. */
  envelopeSender?: string | undefined;
  /** Address of the host that delivered the message to the edge. */
  sourceAddress?: string | undefined;
  receivedAt: Date;
}

interface Target { alias_id: string; account_id: string; state: "active" | "paused" | "deleted"; usable: boolean }

/** The first Message-ID in the header block, found without parsing the message. */
function messageId(raw: Uint8Array): string | null {
  const head = Buffer.from(raw.subarray(0, 65_536)).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const match = /^message-id:[ \t]*(?:\r?\n[ \t]+)?<([^<>\s]{1,512})>/im.exec(end < 0 ? head : head.slice(0, end));
  return match?.[1] ?? null;
}

/** Resends of one message share an identifier; a message without one is identified by its bytes. */
function dedupeDigest(raw: Uint8Array): Buffer {
  const id = messageId(raw);
  const hash = createHash("sha256");
  return id === null ? hash.update("bytes\0").update(raw).digest() : hash.update("message-id\0").update(id).digest();
}

/**
 * The provider side of the ingress contract. It never parses a message beyond
 * locating its Message-ID, generates no email, and reveals no alias state.
 */
export class EmailBridgeIntake {
  constructor(private readonly sql: SQL, private readonly domain: string, private readonly limits: IntakeLimits = DEFAULT_INTAKE_LIMITS) {}

  private localPart(recipient: string): string | null {
    const value = recipient.trim().toLowerCase(), at = value.lastIndexOf("@");
    if (at < 1 || value.slice(at + 1) !== this.domain) return null;
    const local = value.slice(0, at);
    return ALIAS_LOCAL_PART.test(local) ? local : null;
  }

  private async decide(sql: SQL, recipient: string, lock: boolean): Promise<{ decision: IntakeDecision; target?: Target }> {
    const local = this.localPart(recipient);
    if (!local) return { decision: "reject" };
    // Submission holds the alias row so concurrent deliveries are counted one at a time.
    if (lock) await sql`SELECT 1 FROM email_bridge_aliases WHERE local_part = ${local} FOR UPDATE`;
    const rows = await sql<Target[]>`
      SELECT alias.id AS alias_id, alias.account_id, alias.state,
        (account.closed_at IS NULL AND account.onboarding_state = 'active' AND account.did IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence WHERE fence.account_id = account.id)) AS usable
      FROM email_bridge_aliases alias JOIN provider_accounts account ON account.id = alias.account_id
      WHERE alias.local_part = ${local}`;
    const target = rows[0];
    if (!target || target.state !== "active" || !target.usable) return { decision: "reject" };
    const [usage] = await sql<{ alias_hour: number; account_day: number; pending: string }[]>`
      SELECT
        count(*) FILTER (WHERE intake.alias_id = ${target.alias_id} AND intake.accepted_at > clock_timestamp() - interval '1 hour')::integer AS alias_hour,
        count(*) FILTER (WHERE intake.accepted_at > clock_timestamp() - interval '1 day')::integer AS account_day,
        COALESCE(sum(intake.size) FILTER (WHERE intake.raw IS NOT NULL), 0)::text AS pending
      FROM email_bridge_intake intake JOIN email_bridge_aliases alias ON alias.id = intake.alias_id
      WHERE alias.account_id = ${target.account_id}`;
    if (usage && (usage.alias_hour >= this.limits.aliasHourly || usage.account_day >= this.limits.accountDaily ||
      Number(usage.pending) >= this.limits.accountPendingBytes)) return { decision: "defer", target };
    return { decision: "accept", target };
  }

  /** Asked before the message data is accepted, so refusal can happen in the SMTP transaction. */
  async check(recipient: string): Promise<IntakeDecision> {
    return (await this.decide(this.sql, recipient, false)).decision;
  }

  async submit(message: IntakeMessage): Promise<SubmitResult> {
    if (message.raw.length === 0 || message.raw.length > this.limits.maxMessageBytes) return "reject";
    const digest = dedupeDigest(message.raw);
    const sender = message.envelopeSender !== undefined && Buffer.byteLength(message.envelopeSender) <= 320 ? message.envelopeSender : null;
    const source = message.sourceAddress !== undefined && isIP(message.sourceAddress) ? message.sourceAddress : null;
    return this.sql.begin(async transaction => {
      const { decision, target } = await this.decide(transaction, message.recipient, true);
      if (decision === "reject" || !target) return "reject";
      // A resend is acknowledged even when the alias is over its rate, so the sender stops retrying.
      const existing = await transaction`SELECT 1 FROM email_bridge_intake WHERE alias_id = ${target.alias_id} AND dedupe_digest = ${digest}`;
      if (existing.length) return "duplicate";
      if (decision === "defer") return "defer";
      await transaction`
        INSERT INTO email_bridge_intake (id, alias_id, dedupe_digest, size, envelope_sender, source_address, received_at, raw)
        VALUES (${randomUUID()}, ${target.alias_id}, ${digest}, ${message.raw.length}, ${sender}, ${source}::inet, ${message.receivedAt}, ${message.raw})`;
      await transaction`
        UPDATE email_bridge_aliases SET message_count = message_count + 1, last_received_at = ${message.receivedAt} WHERE id = ${target.alias_id}`;
      return "accepted";
    });
  }
}
