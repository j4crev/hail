import type { SQL } from "bun";

export interface BridgeSender {
  /** Canonical address of the local account the bridge sends as. */
  address: string;
  /** The Sender Profile category users grant to receive bridged mail. */
  category: string;
}

export interface BridgeAccount { account_id: string; did: string; generation: number | string }

/** The bridge's own account, when it is an active local account. */
export async function bridgeAccount(sql: SQL, sender: BridgeSender): Promise<BridgeAccount | null> {
  const [row] = await sql<BridgeAccount[]>`
    SELECT account.id AS account_id, account.did, generation.generation FROM provider_accounts account
    JOIN account_serving_generations generation ON generation.account_id = account.id
    WHERE account.canonical_address = ${sender.address} AND account.onboarding_state = 'active'
      AND account.activation_verification_mode = 'public' AND account.closed_at IS NULL AND account.did IS NOT NULL`;
  return row ?? null;
}

/**
 * The recipient's own active Grant to the bridge for its category: the user's
 * consent to receive bridged mail at all. Aliases decide which senders reach them.
 */
export async function bridgeGrant(sql: SQL, recipientDid: string, bridge: Pick<BridgeAccount, "account_id" | "did">,
  category: string): Promise<{ grantId: string } | null> {
  const [row] = await sql<{ grant_id: string }[]>`
    SELECT lineage.grant_id FROM grant_lineages lineage JOIN grant_revisions revision ON revision.grant_id = lineage.grant_id
      AND revision.revision = lineage.current_revision
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(revision.scope_payload) = 'string'
      THEN (revision.scope_payload#>>'{}')::jsonb ELSE revision.scope_payload END AS scope) selected
    WHERE lineage.grantee_did = ${bridge.did} AND lineage.grantor_did = ${recipientDid} AND lineage.current_status = 'active'
      AND (revision.expires_at IS NULL OR revision.expires_at > extract(epoch FROM clock_timestamp()))
      AND selected.scope->0->>'type' = 'categories' AND (selected.scope->0->'values') ? ${category}
      AND ((lineage.local_account_id = ${bridge.account_id} AND lineage.local_role = 'grantee') OR EXISTS (
        SELECT 1 FROM collocated_grant_receivers local WHERE local.grant_id = lineage.grant_id AND local.grantee_account_id = ${bridge.account_id}))
    ORDER BY lineage.grant_id LIMIT 1`;
  return row ? { grantId: row.grant_id } : null;
}
