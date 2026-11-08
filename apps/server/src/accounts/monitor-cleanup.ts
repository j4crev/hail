import type { SQL } from "bun";
import type { SignupMonitorClient } from "../onboarding/monitor.js";
import type { SignupEmailClient } from "../onboarding/email.js";

// Lock only the outbox row across bounded network calls. Concurrent workers skip
// it; a crash releases the lock and retries the idempotent remote operations.
export async function cleanAccountMonitor(sql: SQL, monitor: Pick<SignupMonitorClient, "publicKey" | "stop">,
  email: Pick<SignupEmailClient, "removeMonitoring">): Promise<"idle" | "completed" | "retry"> {
  return sql.begin(async tx => {
    const row = (await tx`SELECT c.* FROM account_monitor_cleanup c
      JOIN provider_accounts a ON a.id=c.account_id
      WHERE c.completed_at IS NULL AND c.next_attempt_at<=clock_timestamp() AND a.closed_at IS NOT NULL
      ORDER BY c.next_attempt_at,c.account_id FOR UPDATE OF c SKIP LOCKED LIMIT 1`)[0];
    if (!row) return "idle";
    try {
      if (row.monitor_public_key !== monitor.publicKey) throw new Error("Cleanup monitor pin differs");
      // Remove the external destination first, including pending alert delivery.
      await email.removeMonitoring(row.did, row.operation_cid);
      await monitor.stop(row.did, row.operation_cid);
      await tx`UPDATE account_monitor_cleanup SET completed_at=clock_timestamp(),attempt_count=attempt_count+1
        WHERE account_id=${row.account_id}`;
      return "completed";
    } catch {
      const delay = Math.min(3600, 15 * 2 ** Math.min(Number(row.attempt_count), 8));
      await tx`UPDATE account_monitor_cleanup SET attempt_count=attempt_count+1,
        next_attempt_at=clock_timestamp()+(${delay}::double precision * interval '1 second') WHERE account_id=${row.account_id}`;
      return "retry";
    }
  });
}
