import type { SQL } from "bun";
import { decodePayload, HailCodecError } from "@racrproto/codec";
import { validateBodyBytes } from "../bodies/service.js";
import { withServingGeneration } from "../db/serving.js";
import { UserGrantError } from "../grants/service.js";
import { uuidV7 } from "../identity/uuid-v7.js";
import type { AccountMessaging } from "../accounts/messaging.js";
import { bridgeAccount, bridgeGrant, type BridgeSender } from "./consent.js";

export type { BridgeSender } from "./consent.js";

interface Claimed { id: string; message_id: string; converted_body: Uint8Array; attempts: number; owner_did: string | null }

/**
 * Delivers converted messages as ordinary Grant-authorized hails from the
 * bridge's own account. Runs in the provider, which holds the bridge's keys.
 * The converter's output is untrusted: it is revalidated here before signing.
 */
export class EmailBridgeDelivery {
  constructor(private readonly sql: SQL, private readonly messaging: Pick<AccountMessaging, "sendRelayed">,
    private readonly sender: BridgeSender, private readonly options: { leaseSeconds?: number; maxAttempts?: number } = {}) {}

  /** Delivers at most one converted message. Returns false when nothing was ready. */
  async workOne(): Promise<boolean> {
    const lease = this.options.leaseSeconds ?? 300, maxAttempts = this.options.maxAttempts ?? 8;
    const [claimed] = await this.sql<Claimed[]>`
      UPDATE email_bridge_intake intake SET attempts = intake.attempts + 1, message_id = COALESCE(intake.message_id, ${uuidV7()}::uuid),
        next_attempt_at = clock_timestamp() + ${lease} * interval '1 second'
      FROM email_bridge_aliases alias JOIN provider_accounts account ON account.id = alias.account_id
      WHERE alias.id = intake.alias_id AND intake.id = (SELECT id FROM email_bridge_intake WHERE state = 'converted'
        AND next_attempt_at <= clock_timestamp() ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING intake.id, intake.message_id, intake.converted_body, intake.attempts,
        CASE WHEN alias.state = 'active' AND account.closed_at IS NULL AND account.onboarding_state = 'active'
          AND NOT EXISTS (SELECT 1 FROM provider_migration_fences fence WHERE fence.account_id = account.id) THEN account.did END AS owner_did`;
    if (!claimed) return false;
    // Every write below is conditional on the claim, so a reclaimed or deleted message is left alone.
    const abandon = async (failure: string) => {
      await this.sql`UPDATE email_bridge_intake SET state = 'dead', converted_body = NULL, failure = ${failure} WHERE id = ${claimed.id} AND state = 'converted' AND attempts = ${claimed.attempts}`;
      return true;
    };
    if (!claimed.owner_did) return abandon("recipient unavailable");

    const body = new Uint8Array(claimed.converted_body);
    try {
      const profile = validateBodyBytes(body);
      if (profile === "spt-1") return abandon("converted body is invalid");
      const document = profile === "spt-2" ? decodePayload("hail.body.spt-2", body) : decodePayload("hail.body.spt-3", body);
      // Every bridged message states that it was relayed from email.
      if (document.origin?.type !== "email") return abandon("converted body is invalid");
    } catch { return abandon("converted body is invalid"); }

    const bridge = await bridgeAccount(this.sql, this.sender);
    if (!bridge) {
      // Misconfiguration is the operator's to fix; keep the message rather than lose it.
      await this.sql`UPDATE email_bridge_intake SET attempts = attempts - 1, next_attempt_at = clock_timestamp() + interval '5 minutes' WHERE id = ${claimed.id} AND state = 'converted' AND attempts = ${claimed.attempts}`;
      throw new Error("Email bridge sender account is not an active local account");
    }
    // Without the recipient's Grant there is no consent to deliver; holding the mail would not change that.
    const grantId = (await bridgeGrant(this.sql, claimed.owner_did, bridge, this.sender.category))?.grantId;
    if (!grantId) return abandon("no active grant to the bridge");

    try {
      await withServingGeneration(bridge.account_id, Number(bridge.generation), () =>
        this.messaging.sendRelayed(bridge.did, { messageId: claimed.message_id, grantId, category: this.sender.category, body }));
    } catch (error) {
      if (error instanceof UserGrantError || error instanceof HailCodecError) return abandon(`delivery refused: ${error.message.slice(0, 200)}`);
      if (claimed.attempts >= maxAttempts) return abandon("delivery kept failing");
      const retry = Math.min(3600, 30 * 2 ** claimed.attempts);
      await this.sql`UPDATE email_bridge_intake SET next_attempt_at = clock_timestamp() + ${retry} * interval '1 second' WHERE id = ${claimed.id} AND state = 'converted' AND attempts = ${claimed.attempts}`;
      return true;
    }
    await this.sql`UPDATE email_bridge_intake SET state = 'delivered', converted_body = NULL WHERE id = ${claimed.id} AND state = 'converted' AND attempts = ${claimed.attempts}`;
    return true;
  }
}
