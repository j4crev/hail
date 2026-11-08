import { isDeepStrictEqual } from 'node:util';
import { def, assureValidNextOp } from '@did-plc/lib';
import type { SQL } from 'bun';
import { IncidentCapabilities } from './incident-capabilities.js';
import { parseJsonWithoutDuplicateKeys } from './strict-json.js';
import { boundedBody } from './http.js';
import { validateAudit, assertAuditContinuity, operationCid } from './audit.js';
import { recoveryPlan } from './recovery.js';
import { plcStateDigest, type MonitorPlcClient } from './plc.js';
import type { PlcMonitor } from './monitor.js';
import { alertMessage } from '../deploy/cloudflare-alert-worker/alert-message.js';
import { incidentHtml } from './incident-page.js';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const cookieName = '__Host-plc-incident';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
export class IncidentService {
  constructor(readonly sql: SQL, readonly monitor: PlcMonitor, readonly plc: MonitorPlcClient) {}

  async snapshot(id: string, allowUnavailable = false) {
    const row = (await this.sql`SELECT a.id,a.did,a.category,a.detail,a.created_at,w.expected_cid,w.expected_state,
      w.last_audit,w.last_polled_at,w.poll_ready FROM monitor_alerts a JOIN monitored_dids w ON w.did=a.did
      WHERE a.id=${id} AND w.stopped_at IS NULL`)[0];
    if (!row) throw new Error('Incident unavailable');
    for (const key of ['detail','expected_state','last_audit']) if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
    // Fresh directory evidence is required for actions, even if the regular poll is healthy.
    let current: Awaited<ReturnType<typeof validateAudit>>;
    let directoryVerified = true;
    try {
      current = await validateAudit(row.did, await this.plc.getAuditableLog(row.did));
      if (row.last_audit) assertAuditContinuity(row.last_audit, current.audit);
    } catch (error) {
      if (!allowUnavailable) throw error;
      directoryVerified = false;
      current = { cid: '', state: null, audit: [], active: [] };
    }
    const operation = current.audit.find(entry => entry.cid === row.detail.operationCid);
    const recovery = (await this.sql`SELECT operation_cid,observed_at,operation,mode,reviewed_current_cid FROM monitor_recoveries WHERE alert_id=${id}`)[0];
    if (recovery && typeof recovery.operation === 'string') recovery.operation = JSON.parse(recovery.operation);
    const observed = recovery && current.audit.some(entry => entry.cid === recovery.operation_cid && !entry.nullified);
    if (observed) await this.sql`UPDATE monitor_recoveries SET observed_at=coalesce(observed_at,clock_timestamp()) WHERE alert_id=${id}`;
    const approved = (await this.sql`SELECT 'local-operator' AS authority FROM monitor_approvals WHERE did=${row.did} AND operation_cid=${current.cid}
      UNION ALL SELECT 'email-capability' AS authority FROM monitor_incident_approvals WHERE did=${row.did} AND operation_cid=${current.cid}`)[0];
    const message = alertMessage({ ...row, occurred_at: row.created_at.toISOString() });
    return { id, did: row.did as string, category: row.category as string, detail: row.detail,
      directoryVerified, recoveryCid: directoryVerified ? row.detail.operationCid ?? (current.state === null ? current.cid : null) : null,
      summary: message.text.split('\n\nTechnical details')[0]!,
      currentCid: current.cid, currentState: current.state, currentDigest: current.state ? plcStateDigest(current.state) : null,
      expectedCid: row.expected_cid as string, expectedState: row.expected_state,
      operationStatus: !directoryVerified ? 'unavailable' : operation ? operation.nullified ? 'nullified' : operation.cid === current.cid ? 'current' : 'superseded' : 'not-applicable',
      approvalAuthority: approved?.authority ?? null,
      checkedAt: new Date().toISOString(), lastMonitorPollAt: row.last_polled_at?.toISOString() ?? null,
      monitorReady: row.poll_ready as boolean,
      recovery: recovery ? { cid: recovery.operation_cid as string, operation: recovery.operation, mode: recovery.mode, reviewedCurrentCid: recovery.reviewed_current_cid, observed: Boolean(observed), current: recovery.operation_cid === current.cid } : null,
      audit: current.audit };
  }

  async approve(id: string, cid: unknown, digest: unknown) {
    const current = await this.snapshot(id);
    if (!current.currentState || current.detail.operationCid !== cid || current.currentCid !== cid || current.currentDigest !== digest)
      throw new Error('The reviewed state is no longer current; reload and review again');
    if (current.expectedCid === cid) return;
    await this.monitor.pollDid(current.did);
    await this.monitor.approveExpected(current.did, current.currentCid, current.currentState, id);
  }

  async submit(id: string, reviewedCurrentCid: unknown, rawOperation: unknown, mode: unknown) {
    if (mode !== "restore" && mode !== "protect") throw new Error("Invalid recovery choice");
    const operation = def.operation.parse(rawOperation), cid = await operationCid(operation);
    const snapshot = await this.snapshot(id);
    const existing = (await this.sql`SELECT operation_cid FROM monitor_recoveries WHERE alert_id=${id}`)[0];
    if (existing && existing.operation_cid !== cid) throw new Error('This incident already has a different signed recovery; retain and check the original');
    if (existing && snapshot.audit.some(entry => entry.cid === cid)) return this.snapshot(id);
    if (snapshot.currentCid !== reviewedCurrentCid) throw new Error('Identity changed since review; reload before signing again');
    const recoveryKey = operation.rotationKeys[0], identityKey = operation.verificationMethods['hail-identity'];
    if (!recoveryKey || !identityKey || typeof snapshot.recoveryCid !== 'string') throw new Error('Invalid recovery correction');
    const plan = await recoveryPlan(snapshot.did, snapshot.audit, snapshot.recoveryCid, recoveryKey, identityKey, mode);
    const { sig, ...unsigned } = operation;
    if (!isDeepStrictEqual(plan.operation, unsigned)) throw new Error('Operation differs from the reviewed recovery plan');
    await assureValidNextOp(snapshot.did, plan.audit.active, operation, new Date());
    // Save exact signed bytes before the network boundary. Retries never re-sign.
    await this.sql.begin(async tx => {
      const account = (await tx`SELECT stopped_at FROM monitored_dids WHERE did=${snapshot.did} FOR UPDATE`)[0];
      if (!account || account.stopped_at) throw new Error('Monitoring stopped');
      const prior = (await tx`SELECT operation_cid FROM monitor_recoveries WHERE alert_id=${id}`)[0];
      if (prior && prior.operation_cid !== cid) throw new Error('Recovery already prepared');
      await tx`INSERT INTO monitor_recoveries(alert_id,reviewed_current_cid,operation,operation_cid,mode)
        VALUES (${id},${snapshot.currentCid},${JSON.stringify(operation)}::jsonb,${cid},${mode}) ON CONFLICT (alert_id) DO NOTHING`;
    });
    if (!this.plc.submitOperation) throw new Error('Directory submission unavailable');
    try { await this.plc.submitOperation(snapshot.did, operation); }
    catch { /* A timeout is ambiguous: read back exact CID before reporting. */ }
    await this.monitor.pollDid(snapshot.did);
    return this.snapshot(id);
  }
}

export function createIncidentApi(capabilities: IncidentCapabilities, service: IncidentService,
  assets: { javascript: string; stylesheet: string }) {
  let start = Date.now(), requests = 0;
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/incidents/')) return json({ error: 'Not found' }, 404);
    if (Date.now() - start > 60_000) { start = Date.now(); requests = 0; }
    if (++requests > 300) return json({ error: 'Please retry shortly' }, 429);
    if (request.method === 'GET' && ['/incidents/app.js','/incidents/style.css'].includes(url.pathname))
      return new Response(url.pathname.endsWith('.js') ? assets.javascript : assets.stylesheet,
        { headers: { ...headers, 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' } });
    const [, , id, action] = url.pathname.split('/');
    if (!id || !UUID.test(id) || url.pathname !== `/incidents/${id}${action ? `/${action}` : ''}`) return json({ error: 'Not found' }, 404);
    if (request.method === 'GET' && !action) return new Response(incidentHtml, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    const session = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
    if (request.method === 'GET' && action === 'data') {
      if (!await capabilities.authorized(id, session)) return json({ error: 'Open your private email link to continue' }, 401);
      try { return json(await service.snapshot(id, true)); }
      catch { return json({ error: 'Current directory history could not be verified. Actions are unavailable; retry shortly.' }, 503); }
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (request.headers.get('origin') !== capabilities.origin || request.headers.get('content-type') !== 'application/json' ||
        request.headers.has('content-encoding')) return json({ error: 'Invalid request origin or content type' }, 403);
    const bytes = await boundedBody(request, 16_384);
    if (!bytes) return json({ error: 'Request too large or empty' }, 413);
    let body: Record<string, unknown>;
    try { body = parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); }
    catch { return json({ error: 'Invalid request' }, 400); }
    try {
      if (action === 'redeem' && typeof body.token === 'string' && Object.keys(body).length === 1) {
        const token = await capabilities.redeem(id, body.token);
        if (!token) return json({ error: 'Link expired or already used. Request a fresh email below.' }, 401);
        return new Response('{}', { headers: { ...headers, 'Content-Type': 'application/json',
          'Set-Cookie': `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800` } });
      }
      if (action === 'renew' && typeof body.token === 'string' && Object.keys(body).length === 1) {
        await capabilities.renew(id, body.token);
        return json({ message: 'If eligible, a replacement link will be sent to your existing security email. Check your inbox.' });
      }
      if (!await capabilities.authorized(id, session)) return json({ error: 'Your session expired. Reopen the email link and request a replacement.' }, 401);
      if (action === 'approve' && Object.keys(body).length === 2) {
        await service.approve(id, body.cid, body.digest); return json({ approved: true });
      }
      if (action === 'recover' && Object.keys(body).length === 3) return json(await service.submit(id, body.currentCid, body.operation, body.mode));
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      // Known validation errors only; never return SQL, signed operations or request URLs.
      return json({ error: error instanceof Error && /^(This |The reviewed|Identity changed|Recovery already|Operation differs|Invalid recovery|The 72-hour|This kit|The recovery)/.test(error.message)
        ? error.message : 'Action could not be completed. Refresh status before retrying.' }, 409);
    }
  };
  return { async fetch(request: Request): Promise<Response> {
    try { return await handle(request); }
    catch { return json({ error: 'Incident service temporarily unavailable' }, 503); }
  } };
}
