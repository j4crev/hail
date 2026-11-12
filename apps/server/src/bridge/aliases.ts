import type { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";

export class EmailBridgeError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "EmailBridgeError"; }
}

export interface EmailAlias {
  id: string;
  address: string;
  label: string;
  state: "active" | "paused";
  createdAt: Date;
  lastReceivedAt: Date | null;
  messageCount: number;
}

export interface EmailAliasLimits { maxAliasesPerAccount: number }
export const DEFAULT_ALIAS_LIMITS: EmailAliasLimits = { maxAliasesPerAccount: 50 };

interface Row { id: string; local_part: string; label: string; state: "active" | "paused"; created_at: Date; last_received_at: Date | null; message_count: string | number }

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const ALIAS_LOCAL_PART = /^[a-z2-7]{12}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Twelve base32 characters: sixty bits that are the alias's only secret. */
function randomLocalPart(): string {
  return Array.from(randomBytes(12), byte => BASE32[byte & 31]).join("");
}

function label(value: unknown): string {
  if (typeof value !== "string") throw new EmailBridgeError(400, "An alias needs a label");
  const cleaned = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  if (!cleaned || Buffer.byteLength(cleaned) > 160) throw new EmailBridgeError(400, "An alias label is 1 to 160 bytes of text");
  return cleaned;
}

/**
 * Per-subscription email aliases owned by one account. The alias is the consent:
 * removing it stops that sender without the sender's cooperation.
 */
export class EmailAliases {
  constructor(private readonly sql: SQL, private readonly domain: string, private readonly limits: EmailAliasLimits = DEFAULT_ALIAS_LIMITS) {}

  private view(row: Row): EmailAlias {
    return {
      id: row.id, address: `${row.local_part}@${this.domain}`, label: row.label, state: row.state, createdAt: row.created_at,
      lastReceivedAt: row.last_received_at, messageCount: Number(row.message_count),
    };
  }

  async list(accountId: string): Promise<EmailAlias[]> {
    const rows = await this.sql<Row[]>`
      SELECT id, local_part, label, state, created_at, last_received_at, message_count FROM email_bridge_aliases
      WHERE account_id = ${accountId} AND state <> 'deleted' ORDER BY created_at DESC, id`;
    return rows.map(row => this.view(row));
  }

  async create(accountId: string, input: { label: unknown }): Promise<EmailAlias> {
    const name = label(input.label);
    return this.sql.begin(async transaction => {
      // Serialize creation per account so the cap cannot be raced past.
      await transaction`SELECT 1 FROM provider_accounts WHERE id = ${accountId} FOR UPDATE`;
      // Aliases stop at cutover, so an account that is leaving cannot add one.
      const fenced = await transaction`SELECT 1 FROM provider_migration_fences WHERE account_id = ${accountId}`;
      if (fenced.length) throw new EmailBridgeError(409, "Aliases are unavailable while this account is moving");
      const [count] = await transaction<{ total: number }[]>`
        SELECT count(*)::integer AS total FROM email_bridge_aliases WHERE account_id = ${accountId} AND state <> 'deleted'`;
      if ((count?.total ?? 0) >= this.limits.maxAliasesPerAccount) throw new EmailBridgeError(409, "This account has reached its alias limit");
      const [row] = await transaction<Row[]>`
        INSERT INTO email_bridge_aliases (id, account_id, local_part, label) VALUES (${randomUUID()}, ${accountId}, ${randomLocalPart()}, ${name})
        RETURNING id, local_part, label, state, created_at, last_received_at, message_count`;
      return this.view(row!);
    });
  }

  /** Renames, pauses or resumes. A paused alias refuses mail but keeps its address. */
  async update(accountId: string, id: unknown, change: { label?: unknown; state?: unknown }): Promise<EmailAlias> {
    if (typeof id !== "string" || !UUID.test(id)) throw new EmailBridgeError(404, "Alias not found");
    if (change.state !== undefined && change.state !== "active" && change.state !== "paused") throw new EmailBridgeError(400, "An alias is active or paused");
    const name = change.label === undefined ? null : label(change.label);
    const [row] = await this.sql<Row[]>`
      UPDATE email_bridge_aliases SET label = COALESCE(${name}::text, label), state = COALESCE(${change.state ?? null}::text, state)
      WHERE id = ${id} AND account_id = ${accountId} AND state <> 'deleted'
      RETURNING id, local_part, label, state, created_at, last_received_at, message_count`;
    if (!row) throw new EmailBridgeError(404, "Alias not found");
    return this.view(row);
  }

  /** Permanent: the address is never issued again and queued mail for it is discarded. */
  async remove(accountId: string, id: unknown): Promise<void> {
    if (typeof id !== "string" || !UUID.test(id)) throw new EmailBridgeError(404, "Alias not found");
    await this.sql.begin(async transaction => {
      const rows = await transaction`
        UPDATE email_bridge_aliases SET state = 'deleted', deleted_at = clock_timestamp()
        WHERE id = ${id} AND account_id = ${accountId} AND state <> 'deleted' RETURNING id`;
      if (!rows.length) throw new EmailBridgeError(404, "Alias not found");
      await transaction`
        UPDATE email_bridge_intake SET state = 'dead', raw = NULL, converted_body = NULL, failure = 'alias deleted'
        WHERE alias_id = ${id} AND state IN ('queued','converting','converted')`;
    });
  }
}
