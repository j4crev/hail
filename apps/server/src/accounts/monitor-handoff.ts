import { decodeDeterministic, type HailValue } from "@racrproto/codec";
import { PUBLIC_EVIDENCE_LIMITS } from "../plc/read-evidence.js";
import type { SQL } from "bun";
import type { SignupMonitorClient } from "../onboarding/monitor.js";
import { requirePublicCutoverEvidence } from "../migration/public-cutover-evidence.js";

// Discover from retained, successful public activations. No portable snapshot
// format changes, caller-supplied ownership or private-test imports are trusted.
export async function handoffAccountMonitor(sql: SQL, monitor: Pick<SignupMonitorClient, "publicKey" | "handoff">) {
  return sql.begin(async tx => {
    const candidate = (await tx`SELECT p.*,a.id AS account_id,g.generation,e.operation_cid FROM pending_migration_imports p
      JOIN provider_accounts a ON a.did=p.did AND a.activated_at=p.activated_at
      JOIN account_serving_generations g ON g.account_id=a.id
      JOIN public_cutover_evidence_selection s ON s.transfer_id=p.transfer_id AND s.activated_at=p.activated_at
      JOIN public_cutover_evidence e ON e.transfer_id=s.transfer_id AND e.evidence_digest=s.evidence_digest
      WHERE p.state='active' AND a.closed_at IS NULL AND NOT EXISTS
        (SELECT 1 FROM account_monitor_handoffs h WHERE h.transfer_id=p.transfer_id)
      ORDER BY p.activated_at,p.transfer_id FOR UPDATE OF a SKIP LOCKED LIMIT 1`)[0];
    if (candidate) {
      // Validate the selected immutable evidence and monitor pin before adopting
      // responsibility. Other monitors remain independently managed.
      const evidence = await requirePublicCutoverEvidence(tx as SQL, { transferId: candidate.transfer_id, did: candidate.did,
        manifestDigest: candidate.manifest_digest, operationBytes: candidate.signed_plc_operation_bytes,
        activatedAt: candidate.activated_at });
      const bundle = decodeDeterministic(evidence.bundle_bytes, PUBLIC_EVIDENCE_LIMITS) as Record<string,HailValue>;
      const publicKey = (bundle.monitor as Record<string,HailValue>).public_key as string;
      await tx`INSERT INTO account_monitor_handoffs(transfer_id,account_id,serving_generation,did,operation_cid,monitor_public_key,completed_at,outcome)
        VALUES (${candidate.transfer_id},${candidate.account_id},${candidate.generation},${candidate.did},${candidate.operation_cid},${publicKey},
          ${publicKey === monitor.publicKey ? null : new Date()},${publicKey === monitor.publicKey ? null : "independent"})
        ON CONFLICT(transfer_id) DO NOTHING`;
    }
    const row = (await tx`SELECT h.*,g.generation,a.closed_at,p.activated_at AS imported_at,a.activated_at AS current_activation
      FROM account_monitor_handoffs h JOIN provider_accounts a ON a.id=h.account_id
      JOIN account_serving_generations g ON g.account_id=a.id LEFT JOIN pending_migration_imports p ON p.transfer_id=h.transfer_id
      WHERE h.completed_at IS NULL AND h.next_attempt_at<=clock_timestamp()
      ORDER BY h.next_attempt_at,h.transfer_id FOR UPDATE OF h,a SKIP LOCKED LIMIT 1`)[0];
    if (!row) return "idle";
    if (row.serving_generation !== row.generation || row.closed_at || row.imported_at?.getTime() !== row.current_activation?.getTime()) {
      await tx`UPDATE account_monitor_handoffs SET completed_at=clock_timestamp(),outcome='superseded' WHERE transfer_id=${row.transfer_id}`;
      return "superseded";
    }
    try {
      if (row.monitor_public_key !== monitor.publicKey) throw Error("Monitor pin changed");
      const managed = await monitor.handoff(row.did,row.operation_cid,row.transfer_id);
      if (managed) await tx`INSERT INTO account_monitor_bindings(account_id,did,operation_cid,monitor_public_key,serving_generation)
        VALUES (${row.account_id},${row.did},${row.operation_cid},${row.monitor_public_key},${row.serving_generation})
        ON CONFLICT(account_id) DO UPDATE SET operation_cid=excluded.operation_cid,monitor_public_key=excluded.monitor_public_key,
          serving_generation=excluded.serving_generation`;
      await tx`UPDATE account_monitor_handoffs SET completed_at=clock_timestamp(),outcome=${managed ? "managed" : "independent"},
        attempt_count=attempt_count+1 WHERE transfer_id=${row.transfer_id}`;
      return managed ? "managed" : "independent";
    } catch {
      const seconds = Math.min(3600,15 * 2 ** Math.min(Number(row.attempt_count),8));
      await tx`UPDATE account_monitor_handoffs SET attempt_count=attempt_count+1,
        next_attempt_at=clock_timestamp()+${seconds}*interval '1 second' WHERE transfer_id=${row.transfer_id}`;
      return "retry";
    }
  });
}
