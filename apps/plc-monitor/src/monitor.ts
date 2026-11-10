import { ProviderAdmissionError } from "./providers.js";
import { validateAudit, assertAuditContinuity } from "./audit.js";
import { operationDetail } from "./operation-detail.js";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { assureValidSig, def, type DocumentData, type ExportedOp } from "@did-plc/lib";
import type { SQL } from "bun";
import { plcStateDigest, type MonitorPlcClient } from "./plc.js";
import type { MonitorSigner } from "./signing.js";

export interface MonitorPollResult {
  state: "current" | "unavailable" | "invalid-log";
  inspected: number;
  alerts: number;
}

export class OnboardingMonitorPending extends Error {
  constructor() { super("Independent onboarding monitor coverage is unavailable"); }
}

export class PlcMonitor {
  constructor(private readonly sql: SQL, private readonly plc: MonitorPlcClient,
    private readonly now: () => Date = () => new Date()) {}

  async enroll(did: string, expectedCid: string, alertWebhookUrl: string, reviewed?: DocumentData, providerId?: string): Promise<void> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^b[a-z2-7]+$/.test(expectedCid)) {
      throw new Error("Monitor DID or expected PLC CID is not canonical");
    }
    assertWebhookUrl(alertWebhookUrl);
    const current = await this.readState(did);
    if (current.cid !== expectedCid) throw new Error("Expected PLC CID does not match current valid state");
    if (reviewed !== undefined && !isDeepStrictEqual(def.documentData.strict().parse(reviewed), current.state)) {
      throw new Error("Reviewed bootstrap checkpoint does not match the complete current PLC state");
    }
    const enrolledAt = this.now();
    await this.sql.begin(async (tx) => {
      // Bound total ongoing work and serialize quota checks with insertion.
      if (providerId) await tx`SELECT pg_advisory_xact_lock(686169156)`;
      const provider = providerId ? (await tx`SELECT * FROM monitor_enrollment_providers
        WHERE id=${providerId} AND enabled FOR UPDATE`)[0] : undefined;
      if (providerId && (!provider || provider.provider_origin + "/hail" !== current.state.services.hail?.endpoint ||
        provider.alert_origin + "/hail/signup" !== alertWebhookUrl))
        throw new ProviderAdmissionError(403, "Provider enrollment disabled or mismatched");
      // Serialize initial enrollment and exact retries without taking the cursor
      // lock before watched rows (polling locks watched rows before the cursor).
      await tx`SELECT pg_advisory_xact_lock(686169155, hashtext(${did}))`;
      const prior = (await tx<{ expected_cid: string; expected_state: unknown; alert_webhook_url: string;
        bootstrap_cid: string | null; bootstrap_state: unknown; stopped_at: Date | null; enrollment_provider_id: string | null }[]>`
        SELECT watched.expected_cid,watched.expected_state,watched.alert_webhook_url,watched.stopped_at,watched.enrollment_provider_id,
          bootstrap.operation_cid AS bootstrap_cid,bootstrap.reviewed_state AS bootstrap_state
        FROM monitored_dids watched LEFT JOIN monitor_bootstrap_checkpoints bootstrap ON bootstrap.did=watched.did
        WHERE watched.did=${did} FOR UPDATE OF watched`)[0];
      if (prior) {
        if (providerId && prior.enrollment_provider_id !== providerId)
          throw new ProviderAdmissionError(409, "Identity belongs to a different enrollment");
        if (prior.stopped_at) throw new Error("Monitoring was stopped for this identity");
        const expected = typeof prior.expected_state === "string" ? JSON.parse(prior.expected_state) : prior.expected_state;
        const bootstrap = typeof prior.bootstrap_state === "string" ? JSON.parse(prior.bootstrap_state) : prior.bootstrap_state;
        if (prior.expected_cid !== expectedCid || prior.alert_webhook_url !== alertWebhookUrl ||
          !isDeepStrictEqual(expected, current.state) || Boolean(prior.bootstrap_cid) !== (reviewed !== undefined) ||
          reviewed !== undefined && (prior.bootstrap_cid !== expectedCid || !isDeepStrictEqual(bootstrap, reviewed))) {
          throw new Error("Monitor enrollment retry differs from retained bootstrap or alert destination");
        }
        return; // Never reset coverage, alerts, approvals or the original checkpoint.
      }
      if (provider) {
        const [usage] = await tx`SELECT
          count(*) FILTER (WHERE stopped_at IS NULL)::integer AS total,
          count(*) FILTER (WHERE enrollment_provider_id=${providerId!} AND stopped_at IS NULL)::integer AS active,
          count(*) FILTER (WHERE enrollment_provider_id=${providerId!} AND enrolled_at>clock_timestamp()-interval '24 hours')::integer AS recent
          FROM monitored_dids`;
        if (usage!.total >= 1000 || usage!.active >= provider.max_identities || usage!.recent >= provider.enrollments_per_day)
          throw new ProviderAdmissionError(429, "Enrollment capacity reached; existing monitoring continues");
      }
      await tx`INSERT INTO monitored_dids (did, expected_cid, expected_state, alert_webhook_url, enrollment_provider_id,
        management_cid, enrolled_at, last_verified_cid, last_verified_at, last_audit, coverage_since)
        VALUES (${did}, ${expectedCid}, ${JSON.stringify(current.state)}::jsonb,
          ${alertWebhookUrl}, ${providerId ?? null}, ${providerId ? expectedCid : null}, ${enrolledAt}, ${expectedCid}, ${enrolledAt},
          ${JSON.stringify(current.audit)}::jsonb, ${enrolledAt})`;
      if (reviewed !== undefined) {
        await tx`INSERT INTO monitor_bootstrap_checkpoints (did, operation_cid, reviewed_state, reviewed_at)
          VALUES (${did}, ${expectedCid}, ${JSON.stringify(current.state)}::jsonb, ${enrolledAt})`;
        await this.alert(tx, did, "onboarding-enrollment", `onboarding:${did}:${expectedCid}`,
          { operationCid: expectedCid, enrolledAt: enrolledAt.toISOString() });
      }
    });
  }

  // Only the authenticated provider's retained managed enrollment is in scope.
  // Retain a tombstone and audit history so old enrollment retries cannot restart it.
  async stopManaged(did: string, operationCid: string, providerOrigin: string, alertWebhookUrl: string, providerId?: string): Promise<void> {
    await this.sql.begin(async tx => {
      if (providerId && !(await tx`SELECT id FROM monitor_enrollment_providers
        WHERE id=${providerId} AND enabled AND provider_origin=${providerOrigin}
          AND alert_origin || '/hail/signup'=${alertWebhookUrl} FOR SHARE`).length)
        throw new ProviderAdmissionError(403, "Provider enrollment disabled or mismatched");
      await tx`SELECT pg_advisory_xact_lock(686169155, hashtext(${did}))`;
      const row = (await tx`SELECT b.operation_cid,b.reviewed_state,w.management_cid,w.alert_webhook_url,w.enrollment_provider_id
        FROM monitored_dids w JOIN monitor_bootstrap_checkpoints b ON b.did=w.did
        WHERE w.did=${did} FOR UPDATE OF w`)[0];
      const state = row && (typeof row.reviewed_state === "string" ? JSON.parse(row.reviewed_state) : row.reviewed_state);
      if (!row || (providerId ? row.enrollment_provider_id !== providerId || row.management_cid !== operationCid :
        row.enrollment_provider_id !== null || row.operation_cid !== operationCid || row.alert_webhook_url !== alertWebhookUrl ||
        state?.services?.hail?.type !== "HailMessaging" || state.services.hail.endpoint !== `${providerOrigin}/hail`))
        throw new Error("Managed enrollment does not match");
      if (providerId) await tx`INSERT INTO monitor_receiver_cleanup(did,operation_cid,receiver_url)
        VALUES (${did},${row.operation_cid},${row.alert_webhook_url}) ON CONFLICT(did) DO NOTHING`;
      await tx`UPDATE monitored_dids SET stopped_at=coalesce(stopped_at,clock_timestamp()),poll_ready=false WHERE did=${did}`;
      await tx`UPDATE monitor_alerts SET lease_token=NULL,lease_expires_at=NULL WHERE did=${did} AND sent_at IS NULL`;
    });
  }

  // A current owner-signed PLC operation authorizes management handoff, not
  // approval of the new expected PLC state. Preserve coverage and alert history.
  async handoff(did: string, operationCid: string, transferId: string, providerId: string,
    claimReceiver: (url: string, did: string, bootstrapCid: string) => Promise<void>): Promise<boolean> {
    const current = await this.readState(did);
    if (current.cid !== operationCid) throw new Error("Handoff must name the current PLC operation");
    return this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(686169156)`;
      const provider = (await tx`SELECT * FROM monitor_enrollment_providers WHERE id=${providerId} AND enabled AND retired_at IS NULL FOR UPDATE`)[0];
      if (!provider || current.state.services.hail?.type !== "HailMessaging" ||
        current.state.services.hail.endpoint !== provider.provider_origin + "/hail") throw new Error("Destination provider differs");
      await tx`SELECT pg_advisory_xact_lock(686169155, hashtext(${did}))`;
      const row = (await tx`SELECT w.*,b.operation_cid AS bootstrap_cid FROM monitored_dids w
        LEFT JOIN monitor_bootstrap_checkpoints b ON b.did=w.did WHERE w.did=${did} FOR UPDATE OF w`)[0];
      if (!row || !row.enrollment_provider_id) return false; // Never claim independently managed monitoring.
      if (row.stopped_at || !row.bootstrap_cid) throw new Error("Stopped enrollment cannot be transferred");
      const receipt = (await tx`SELECT * FROM monitor_management_handoffs WHERE transfer_id=${transferId}`)[0];
      if (receipt) {
        if (receipt.did !== did || receipt.to_provider !== providerId || receipt.operation_cid !== operationCid ||
          row.enrollment_provider_id !== providerId || row.management_cid !== operationCid) throw new Error("Handoff retry differs");
        return true;
      }
      if (row.enrollment_provider_id === providerId) throw new Error("Identity already belongs to this provider");
      const expected = typeof row.expected_state === "string" ? JSON.parse(row.expected_state) : row.expected_state;
      const audit = typeof row.last_audit === "string" ? JSON.parse(row.last_audit) : row.last_audit;
      this.assertNoHistoryRegression(audit, current.audit);
      const operation = current.audit.find(entry => entry.cid === operationCid && !entry.nullified)!.operation;
      // The trusted owner's highest-priority key is required; provider rotation
      // authority alone must never transfer control over security notifications.
      await assureValidSig([expected.rotationKeys[0]], operation);
      const [usage] = await tx`SELECT count(*)::integer AS active FROM monitored_dids
        WHERE enrollment_provider_id=${providerId} AND stopped_at IS NULL`;
      if (usage!.active >= provider.max_identities) throw new ProviderAdmissionError(429, "Destination enrollment capacity reached");
      // Lock ownership across the bounded receiver request. An old-provider stop
      // either wins before handoff or is rejected after it; never erase email first.
      await claimReceiver(row.alert_webhook_url, did, row.bootstrap_cid);
      await tx`INSERT INTO monitor_management_handoffs(transfer_id,did,from_provider,to_provider,operation_cid)
        VALUES (${transferId},${did},${row.enrollment_provider_id},${providerId},${operationCid})`;
      await tx`UPDATE monitored_dids SET enrollment_provider_id=${providerId},management_cid=${operationCid} WHERE did=${did}`;
      return true;
    });
  }

  async poll(_legacyCount?:number): Promise<MonitorPollResult> {
    return this.pollWatched();
  }

  // Bootstrap one account immediately without waiting for the periodic sweep.
  // Reuse the full audit checks, but never claim fleet-wide cursor health.
  async pollDid(did: string): Promise<MonitorPollResult> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("Monitor DID is not canonical");
    return this.pollWatched(did);
  }

  private async pollWatched(did?: string): Promise<MonitorPollResult> {
    return this.sql.begin(async (tx): Promise<MonitorPollResult> => {
      const now = this.now();
      let alerts = 0;
      let result:MonitorPollResult["state"]="current",inspected=0;
      const monitored = await tx<{ did:string;expected_cid:string;expected_state:unknown;enrolled_at:Date;
        last_polled_at:Date|null;last_audit:unknown;poll_ready:boolean }[]>`SELECT did,expected_cid,expected_state,enrolled_at,last_polled_at,last_audit,poll_ready
        FROM monitored_dids WHERE stopped_at IS NULL AND (${did ?? null}::text IS NULL OR did=${did ?? null}) ORDER BY did FOR UPDATE`;
      for (const row of monitored) {
        const baseline = row.last_polled_at && row.last_polled_at > row.enrolled_at ? row.last_polled_at : row.enrolled_at;
        const coverageGap = now.getTime() - baseline.getTime() > 86_400_000;
        if (coverageGap) alerts += await this.alert(tx, row.did, "coverage-lost",
          `coverage:${row.did}:${baseline.toISOString()}`,
          { lastHealthyAt: row.last_polled_at?.toISOString() ?? null, enrolledAt: row.enrolled_at.toISOString(), observedAt: now.toISOString() });
        let rawAudit:ExportedOp[];
        try { rawAudit=await this.plc.getAuditableLog(row.did); }
        catch { result=result==="invalid-log"?result:"unavailable";await tx`UPDATE monitored_dids SET poll_ready=false WHERE did=${row.did}`;continue; }
        try {
          const current=await this.readState(row.did,rawAudit);
          const previous=typeof row.last_audit==="string"?JSON.parse(row.last_audit) as ExportedOp[]:row.last_audit as ExportedOp[]|null;
          if(previous)this.assertNoHistoryRegression(previous,current.audit);
          const known=new Set((previous??[]).map(entry=>entry.cid));
          const approvedState=typeof row.expected_state==="string"?JSON.parse(row.expected_state) as DocumentData:row.expected_state;
          const expected=current.cid===row.expected_cid&&isDeepStrictEqual(current.state,approvedState);
          for(const entry of current.audit)if(!known.has(entry.cid)){
            await tx`INSERT INTO monitor_observations (did,cid,seq,operation,expected)
              VALUES (${row.did},${entry.cid},NULL,${JSON.stringify(entry.operation)}::jsonb,${expected})
              ON CONFLICT (did,cid) DO NOTHING`;
            if(entry.cid!==row.expected_cid)alerts+=await this.alert(tx,row.did,"unexpected-operation",`operation:${row.did}:${entry.cid}`,
              operationDetail(entry,current.audit,current.cid,row.expected_cid,now));
            inspected+=1;
          }
          if(!expected)alerts+=await this.alert(tx,row.did,"unexpected-operation",`operation:${row.did}:${current.cid}`,
            operationDetail(current.audit.find(entry=>entry.cid===current.cid)!,current.audit,current.cid,row.expected_cid,now));
          // Report later changes in the disposition of an already reported operation.
          const previousCurrentCid = previous?.filter(entry => !entry.nullified).at(-1)?.cid;
          for (const prior of previous ?? []) {
            const entry = current.audit.find(entry => entry.cid === prior.cid)!;
            const wasCurrent = prior.cid === previousCurrentCid;
            if ((!prior.nullified && entry.nullified) || wasCurrent && entry.cid !== current.cid) {
              const reported = await tx`SELECT id FROM monitor_alerts WHERE did=${row.did}
                AND correlation=${`operation:${row.did}:${entry.cid}`} LIMIT 1`;
              if (!reported.length) continue;
              alerts += await this.alert(tx,row.did,"operation-status",`status:${row.did}:${entry.cid}:${entry.nullified ? "nullified" : "superseded"}`,
                operationDetail(entry,current.audit,current.cid,row.expected_cid,now));
            }
          }
          if (coverageGap || !row.poll_ready && row.last_polled_at) {
            alerts += await this.alert(tx,row.did,"monitoring-restored",`restored:${row.did}:${baseline.toISOString()}`,
              { observedAt: now.toISOString(), lastHealthyAt: row.last_polled_at?.toISOString() ?? null,
                matchesApprovedState: expected, currentCid: current.cid });
          }
          await tx`UPDATE monitored_dids SET last_audit=${JSON.stringify(current.audit)}::jsonb,last_polled_at=${now},
            coverage_since=COALESCE(coverage_since,${now}),poll_ready=true,
            last_verified_cid=CASE WHEN ${expected} THEN ${current.cid} ELSE last_verified_cid END,
            last_verified_at=CASE WHEN ${expected} THEN ${now} ELSE last_verified_at END WHERE did=${row.did}`;
        } catch {
          result="invalid-log";
          await tx`UPDATE monitored_dids SET poll_ready=false WHERE did=${row.did}`;
          alerts+=await this.alert(tx,row.did,"invalid-operation-log",`invalid:${row.did}`,
            {observedAt:now.toISOString()});
        }
      }
      if (did === undefined) await tx`UPDATE monitor_cursor SET caught_up=${result==="current"},
        last_healthy_at=CASE WHEN ${result==="current"} THEN ${now} ELSE last_healthy_at END,updated_at=${now}
        WHERE singleton=true`;
      return {state:result,inspected,alerts};
    });
  }

  // A user-run host's local operator approves the complete reviewed PLC state.
  // A provider-hosted bootstrap monitor cannot treat its own approval as
  // provider-independent user authorization.
  async approveExpected(did: string, cid: string, reviewed: DocumentData, emailAlertId?: string): Promise<void> {
    const current = await this.readState(did);
    if (current.cid !== cid || !isDeepStrictEqual(current.state, reviewed)) {
      throw new Error("Reviewed PLC CID or complete expected state does not match the validated log");
    }
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ expected_cid: string }[]>`
        SELECT expected_cid FROM monitored_dids WHERE did = ${did} AND stopped_at IS NULL FOR UPDATE`;
      const previous = rows[0];
      if (!previous) throw new Error("No monitored identity to approve");
      if (previous.expected_cid === cid) {
        const emailApproval = !emailAlertId && (await tx`SELECT operation_cid FROM monitor_incident_approvals
          WHERE did=${did} AND operation_cid=${cid}`)[0];
        const localApproval = (await tx`SELECT operation_cid FROM monitor_approvals WHERE did=${did} AND operation_cid=${cid}`)[0];
        if (!emailApproval || localApproval) throw new Error("No new monitored operation to approve");
      }
      if (emailAlertId) {
        const alert = (await tx`SELECT detail FROM monitor_alerts WHERE id=${emailAlertId} AND did=${did}
          AND category IN ('unexpected-operation','operation-status')`)[0];
        if (!alert || (typeof alert.detail === "string" ? JSON.parse(alert.detail) : alert.detail).operationCid !== cid) throw new Error("Approval is outside this incident");
      }
      const retained = (await tx`SELECT last_audit FROM monitored_dids WHERE did=${did}`)[0];
      if (retained?.last_audit) this.assertNoHistoryRegression(typeof retained.last_audit === "string" ? JSON.parse(retained.last_audit) : retained.last_audit, current.audit);
      const observation = await tx<{ cid: string }[]>`
        SELECT cid FROM monitor_observations WHERE did = ${did} AND cid = ${cid}`;
      if (!observation.length) throw new Error("Operation has not been observed in the sequenced export");
      if (emailAlertId) {
        await tx`INSERT INTO monitor_incident_approvals (did,operation_cid,previous_expected_cid,approved_state,alert_id)
          VALUES (${did},${cid},${previous.expected_cid},${JSON.stringify(reviewed)}::jsonb,${emailAlertId})`;
      } else {
        await tx`INSERT INTO monitor_approvals (did,operation_cid,previous_expected_cid,approved_state)
          VALUES (${did},${cid},${previous.expected_cid},${JSON.stringify(reviewed)}::jsonb)`;
      }
      await tx`UPDATE monitored_dids SET expected_cid = ${cid}, expected_state = ${JSON.stringify(reviewed)}::jsonb,
        last_verified_cid = ${cid}, last_verified_at = ${this.now()} WHERE did = ${did}`;
    });
  }

  async attest(did: string, transferId: string, operationCid: string, origin: string,
    signer: MonitorSigner): Promise<{ payloadBytes: Uint8Array; signature: Uint8Array }> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(transferId) ||
      !/^b[a-z2-7]+$/.test(operationCid) || assertWebhookUrl(origin).origin !== origin) {
      throw new Error("Monitor attestation needs a canonical DID, transfer ID, CID and HTTPS origin");
    }
    const current = await this.readState(did);
    if (current.cid !== operationCid) throw new Error("Monitor cannot attest a noncurrent PLC operation");
    return this.sql.begin(async tx => {
    const rows = await tx<{ expected_cid: string; expected_state: unknown; enrolled_at: Date;
      coverage_since:Date|null;last_polled_at:Date|null;poll_ready:boolean;
      last_audit:unknown;bootstrap_cid: string | null; bootstrap_state: unknown;
      approved: number; notified: number; gaps: number }[]>`
      SELECT watched.expected_cid, watched.expected_state, watched.enrolled_at,
        watched.coverage_since,watched.last_polled_at,watched.poll_ready,watched.last_audit,
        bootstrap.operation_cid AS bootstrap_cid, bootstrap.reviewed_state AS bootstrap_state,
        (SELECT count(*)::int FROM monitor_approvals approved WHERE approved.did = ${did}
          AND approved.operation_cid = ${operationCid}) AS approved,
        (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
          AND alert.correlation = ${`operation:${did}:${operationCid}`} AND alert.sent_at IS NOT NULL) AS notified,
        (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
          AND alert.category IN ('coverage-lost', 'export-gap', 'invalid-operation-log')) AS gaps
      FROM monitored_dids watched
      LEFT JOIN monitor_bootstrap_checkpoints bootstrap ON bootstrap.did = watched.did
      WHERE watched.did = ${did} AND watched.stopped_at IS NULL FOR SHARE OF watched
    `;
    const watched = rows[0];
    const expectation = typeof watched?.expected_state === "string"
      ? JSON.parse(watched.expected_state) as DocumentData : watched?.expected_state;
    const retained=typeof watched?.last_audit==="string"?JSON.parse(watched.last_audit) as ExportedOp[]:watched?.last_audit as ExportedOp[]|null;
    const now = this.now();
    if (!watched || watched.expected_cid !== operationCid ||
      !isDeepStrictEqual(current.state, expectation) || !watched.coverage_since || !watched.poll_ready ||
      watched.approved !== 1 || watched.notified < 1 || watched.gaps !== 0 ||
      !watched.last_polled_at || now.getTime() - watched.last_polled_at.getTime() > 300_000 ||
      watched.last_polled_at.getTime() > now.getTime() + 300_000 || watched.enrolled_at.getTime() > now.getTime() + 300_000) {
      throw new Error("Independent monitor approval or uninterrupted coverage is unavailable");
    }
    if(!retained)throw new Error("Independent monitor has no retained DID audit");
    this.assertNoHistoryRegression(retained,current.audit);
    if(!isDeepStrictEqual(retained,current.audit))throw new Error("Independent monitor has not polled the current DID audit");
    const bootstrap = typeof watched.bootstrap_state === "string"
      ? JSON.parse(watched.bootstrap_state) as DocumentData : watched.bootstrap_state as DocumentData;
    return signer.signCoverage({ type: "hail.plc-monitor-attestation", version: watched.bootstrap_cid ? 3 : 1,
      did, transfer_id: transferId, operation_cid: operationCid, monitor_origin: origin,
      coverage_since: Math.floor(watched.coverage_since.getTime() / 1000),
      observed_at: Math.floor(now.getTime() / 1000),
      ...(watched.bootstrap_cid ? { bootstrap_cid: watched.bootstrap_cid, bootstrap_state_digest: plcStateDigest(bootstrap) } : {}) });
    });
  }

  async attestOnboarding(did: string, operationCid: string, origin: string,
    signer: MonitorSigner): Promise<{ payloadBytes: Uint8Array; signature: Uint8Array }> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !/^b[a-z2-7]+$/.test(operationCid) ||
      assertWebhookUrl(origin).origin !== origin) throw new Error("Onboarding attestation needs a canonical DID, CID and HTTPS origin");
    const current = await this.readState(did);
    if (current.cid !== operationCid) throw new Error("Monitor cannot attest a noncurrent onboarding operation");
    return this.sql.begin(async tx => {
      const watched = (await tx<{ expected_cid: string; expected_state: unknown; enrolled_at: Date;
        coverage_since:Date|null;last_polled_at:Date|null;poll_ready:boolean;
        last_audit:unknown;bootstrap_cid: string | null; bootstrap_state: unknown; gaps: number; notified: number }[]>`
        SELECT watched.expected_cid, watched.expected_state, watched.enrolled_at,
          watched.coverage_since,watched.last_polled_at,watched.poll_ready,watched.last_audit,
          bootstrap.operation_cid AS bootstrap_cid, bootstrap.reviewed_state AS bootstrap_state,
          (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
            AND alert.category = 'onboarding-enrollment' AND alert.sent_at IS NOT NULL) AS notified,
          (SELECT count(*)::int FROM monitor_alerts alert WHERE alert.did = ${did}
            AND alert.category IN ('coverage-lost', 'export-gap', 'invalid-operation-log')) AS gaps
        FROM monitored_dids watched
        LEFT JOIN monitor_bootstrap_checkpoints bootstrap ON bootstrap.did = watched.did
        WHERE watched.did = ${did} AND watched.stopped_at IS NULL FOR SHARE OF watched
      `)[0];
      const expected = typeof watched?.expected_state === "string" ? JSON.parse(watched.expected_state) : watched?.expected_state;
      const bootstrap = typeof watched?.bootstrap_state === "string" ? JSON.parse(watched.bootstrap_state) : watched?.bootstrap_state;
      const retained=typeof watched?.last_audit==="string"?JSON.parse(watched.last_audit) as ExportedOp[]:watched?.last_audit as ExportedOp[]|null;
      const now = this.now();
      if (!watched || watched.expected_cid !== operationCid || watched.bootstrap_cid !== operationCid ||
        !isDeepStrictEqual(current.state, expected) || !isDeepStrictEqual(current.state, bootstrap) ||
        watched.gaps !== 0 || watched.notified > 1 || watched.enrolled_at.getTime() > now.getTime() + 300_000 ||
        watched.last_polled_at && watched.last_polled_at.getTime() > now.getTime() + 300_000) {
        throw new Error("Independent onboarding monitor coverage is unavailable");
      }
      if (!watched.notified || !watched.coverage_since || !watched.poll_ready || !watched.last_polled_at ||
        watched.last_polled_at.getTime() < watched.enrolled_at.getTime() || now.getTime() - watched.last_polled_at.getTime() > 300_000)
        throw new OnboardingMonitorPending();
      if(!retained)throw new Error("Independent onboarding monitor has no retained DID audit");
      this.assertNoHistoryRegression(retained,current.audit);
      if(!isDeepStrictEqual(retained,current.audit))throw new Error("Independent onboarding monitor has not polled the current DID audit");
      return signer.signOnboardingCoverage({ type: "hail.plc-onboarding-monitor-attestation", version: 2,
        did, operation_cid: operationCid, monitor_origin: origin,
        coverage_since: Math.floor(watched.coverage_since.getTime() / 1000),
        observed_at: Math.floor(now.getTime() / 1000), bootstrap_state_digest: plcStateDigest(current.state),
      });
    });
  }

  private async readState(did:string,source?:readonly unknown[]):Promise<{cid:string;state:DocumentData;audit:ExportedOp[]}>{
    const result = await validateAudit(did, source ?? await this.plc.getAuditableLog(did), this.now().getTime());
    if (!result.state) throw new Error("PLC audit has no valid current state");
    return {cid: result.cid, state: result.state, audit: result.audit};
  }

  private assertNoHistoryRegression(previous: readonly ExportedOp[], current: readonly ExportedOp[]): void {
    assertAuditContinuity(previous, current);
  }

  private async alert(tx: SQL, did: string | null, category: string, correlation: string,
    detail: object): Promise<number> {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO monitor_alerts (id, did, category, correlation, detail)
      VALUES (${randomUUID()}, ${did}, ${category}, ${correlation}, ${JSON.stringify(detail)}::jsonb)
      ON CONFLICT (correlation) DO NOTHING RETURNING id`;
    return inserted.length;
  }
}

export function assertWebhookUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
    !url.hostname || isIP(url.hostname) !== 0 || url.hostname.length > 253 ||
    url.hostname.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error("Monitor alert destination must be a canonical HTTPS DNS URL");
  }
  return url;
}
