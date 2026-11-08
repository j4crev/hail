import { generateKeyPairSync } from 'node:crypto';
import { P256Keypair } from '@atproto/crypto';
import { assureValidNextOp, didForCreateOp, signOperation, addSignature, type ExportedOp, type Operation } from '@did-plc/lib';
import { createUserVault, cipher, unseal } from '@racrproto/client-support/vault-crypto';
import { encodeBase64Url } from '@racrproto/codec/base64url';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MonitorDatabase } from '../src/database.js';
import { MonitorSigner } from '../src/signing.js';
import { PlcMonitor } from '../src/monitor.js';
import { IncidentCapabilities } from '../src/incident-capabilities.js';
import { IncidentService, createIncidentApi } from '../src/incidents.js';
import { operationCid, validateAudit } from '../src/audit.js';
import { recoveryPlan, signRecovery } from '../src/recovery.js';
import { MonitorNotifier } from '../src/notifier.js';
import type { MonitorPlcClient } from '../src/plc.js';

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration('monitor incident authorization and recovery', () => {
  let db: MonitorDatabase;
  const signer = new MonitorSigner(generateKeyPairSync('ed25519').privateKey);
  const origin = 'https://monitor.example.com';
  beforeAll(async () => {
    if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/hail_test_')) throw Error('Use the disposable integration runner');
    db = new MonitorDatabase(process.env.DATABASE_URL!); await db.migrate();
  });
  afterAll(async () => { await db?.close(); });
  async function fixture() {
    const kit = await createUserVault();
    const raw = await unseal(await cipher(kit.recoverySecret), kit.vault.recovery, 'user-recovery');
    const owner = await P256Keypair.import(Uint8Array.from(raw)); raw.fill(0);
    const provider = await P256Keypair.create();
    const genesis = await signOperation({ type: 'plc_operation', prev: null, rotationKeys: [owner.did(), provider.did()],
      verificationMethods: { 'hail-identity': kit.vault.identity.publicDidKey, 'hail-messaging': provider.did() },
      services: { hail: { type: 'HailMessaging', endpoint: 'https://provider.example/hail' } }, alsoKnownAs: [] }, owner);
    const did = await didForCreateOp(genesis); kit.vault.did = did;
    const genesisCid = await operationCid(genesis);
    const epoch = Date.now() - 60_000;
    const audit: ExportedOp[] = [{ did, operation: genesis, cid: genesisCid, nullified: false, createdAt: new Date(epoch).toISOString() }];
    let submitCount = 0, ambiguous = false;
    const client: MonitorPlcClient = {
      async exportAfter() { return []; }, async getOperationLog() { return audit.filter(e => !e.nullified).map(e => e.operation); },
      async getDocumentData() { return (await validateAudit(did, audit)).state!; },
      async getAuditableLog() { return structuredClone(audit); },
      async submitOperation(_did, operation) {
        submitCount++;
        const validated = await validateAudit(did, audit);
        const accepted = await assureValidNextOp(did, validated.active, operation, new Date());
        for (const cid of accepted.nullified) audit.find(e => e.cid === cid.toString())!.nullified = true;
        audit.push({ did, operation, cid: await operationCid(operation), nullified: false, createdAt: new Date().toISOString() });
        if (ambiguous) throw Error('Connection lost after acceptance');
      },
    };
    const monitor = new PlcMonitor(db.sql, client);
    await monitor.enroll(did, genesisCid, 'https://alerts.example.com/hail', (await validateAudit(did, audit)).state!);
    await monitor.pollDid(did);
    const { sig: _signature, ...unsignedGenesis } = genesis;
    const update = await signOperation({ ...unsignedGenesis, prev: genesisCid,
      services: { hail: { type: 'HailMessaging', endpoint: 'https://wrong.example/hail' } } }, provider);
    audit.push({ did, operation: update, cid: await operationCid(update), nullified: false, createdAt: new Date(epoch + 1000).toISOString() });
    await monitor.pollDid(did);
    const alert = (await db.sql`SELECT id,created_at FROM monitor_alerts WHERE did=${did} AND category='unexpected-operation'`)[0]!;
    const caps = new IncidentCapabilities(db.sql, signer, origin), service = new IncidentService(db.sql, monitor, client);
    const api = createIncidentApi(caps, service, { javascript: '', stylesheet: '' });
    const review = await caps.issue(alert as { id: string; created_at: Date });
    const token = new URL(review.url).searchParams.get('token')!;
    const post = (action: string, body: unknown, cookie = '', requestOrigin = origin) => api.fetch(new Request(`${origin}/incidents/${alert.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin, Cookie: cookie }, body: JSON.stringify(body),
    }));
    return { kit, owner, provider, genesis, genesisCid, did, audit, update, alert, caps, service, api, review, token, post, monitor,
      count: () => submitCount, ambiguous: () => { ambiguous = true; } };
  }
  it('GET scanning cannot consume authority; redemption is atomic, scoped and cookie-based', async () => {
    const f = await fixture();
    const page = await f.api.fetch(new Request(f.review.url));
    expect(page.status).toBe(200); expect(await page.text()).not.toContain(f.token);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await db.sql`SELECT consumed_at FROM monitor_incident_capabilities WHERE alert_id=${f.alert.id}`)[0].consumed_at).toBeNull();
    expect((await f.post('redeem', { token: f.token }, '', 'https://evil.example')).status).toBe(403);
    const results = await Promise.all([f.post('redeem', { token: f.token }), f.post('redeem', { token: f.token })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
    const cookie = results.find(r => r.status === 200)!.headers.get('set-cookie')!;
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Strict');
    const session = cookie.split(';')[0]!.split('=')[1]!;
    expect(await f.caps.authorized(f.alert.id, session)).toBe(true);
    expect(await f.caps.authorized(crypto.randomUUID(), session)).toBe(false);
    await db.sql`UPDATE monitor_incident_capabilities SET revoked_at=now() WHERE alert_id=${f.alert.id}`;
    expect(await f.caps.authorized(f.alert.id, session)).toBe(false);
  });
  it('expires links and sessions and renews only to the retained destination with a bounded queue', async () => {
    const f = await fixture();
    await db.sql`UPDATE monitor_incident_capabilities SET expires_at=now()-interval '1 second' WHERE alert_id=${f.alert.id}`;
    expect(await f.caps.redeem(f.alert.id, f.token)).toBeNull();
    await f.caps.renew(f.alert.id, 'x'.repeat(43));
    await f.caps.renew(f.alert.id, f.token); await f.caps.renew(f.alert.id, f.token);
    const renewed = await db.sql`SELECT * FROM monitor_alerts WHERE did=${f.did} AND correlation LIKE 'incident-renewal:%'`;
    expect(renewed).toHaveLength(1);
    const link = await f.caps.issue(renewed[0]);
    const session = await f.caps.redeem(renewed[0].id, new URL(link.url).searchParams.get('token')!);
    expect(await f.caps.authorized(renewed[0].id, session!)).toBe(true);
    await db.sql`UPDATE monitor_incident_sessions SET expires_at=now()-interval '1 second' WHERE alert_id=${renewed[0].id}`;
    expect(await f.caps.authorized(renewed[0].id, session!)).toBe(false);
  });
  it('keeps notifier retry payloads identical, without plaintext tokens in retained alert evidence', async () => {
    const f = await fixture(), payloads: string[] = [];
    await db.sql`UPDATE monitor_alerts SET sent_at=now() WHERE id<>${f.alert.id}`;
    const notifier = new MonitorNotifier(db.sql, signer, { async send(_url, bytes) { payloads.push(new TextDecoder().decode(bytes)); return 503; } }, () => new Date(), f.caps);
    await notifier.sendOne(); await db.sql`UPDATE monitor_alerts SET next_attempt_at=now() WHERE id=${f.alert.id}`;
    await notifier.sendOne(); expect(payloads).toHaveLength(2); expect(payloads[0]).toBe(payloads[1]);
    expect(JSON.parse(payloads[0]!).detail.review.url).toBe(f.review.url);
    expect(JSON.stringify((await db.sql`SELECT detail FROM monitor_alerts WHERE id=${f.alert.id}`)[0])).not.toContain(f.token);
  });
  it('approves only the reviewed incident state and cannot grant independent attestation', async () => {
    const f = await fixture(), state = await f.service.snapshot(f.alert.id);
    await expect(f.service.approve(f.alert.id, state.currentCid, 'wrong')).rejects.toThrow('reviewed state');
    await f.service.approve(f.alert.id, state.currentCid, state.currentDigest);
    expect((await db.sql`SELECT alert_id FROM monitor_incident_approvals WHERE did=${f.did}`)[0].alert_id).toBe(f.alert.id);
    expect(await db.sql`SELECT * FROM monitor_approvals WHERE did=${f.did}`).toHaveLength(0);
    await db.sql`UPDATE monitor_alerts SET sent_at=now() WHERE did=${f.did}`;
    await expect(new PlcMonitor(db.sql, { ...({} as MonitorPlcClient), async getAuditableLog() { return f.audit; } })
      .attest(f.did, crypto.randomUUID(), state.currentCid, origin, signer)).rejects.toThrow('approval');
    await f.monitor.approveExpected(f.did, state.currentCid, state.currentState!);
    expect(await db.sql`SELECT * FROM monitor_approvals WHERE did=${f.did}`).toHaveLength(1);
    expect(await db.sql`SELECT * FROM monitor_incident_approvals WHERE did=${f.did}`).toHaveLength(1);
  });
  it.each(['restore', 'protect'] as const)('performs %s recovery with local signing and exact read-back after an ambiguous response', async mode => {
    const f = await fixture(), cid = await operationCid(f.update);
    const plan = await recoveryPlan(f.did, f.audit, cid, f.owner.did(), f.kit.vault.identity.publicDidKey, mode);
    const operation = await signRecovery(f.did, f.audit, cid, f.kit.vault, encodeBase64Url(f.kit.recoverySecret), plan.operation, mode);
    f.ambiguous();
    const result = await f.service.submit(f.alert.id, plan.currentCid, operation, mode);
    expect(result.recovery).toMatchObject({ observed: true, current: true });
    expect(result.operationStatus).toBe('nullified');
    expect(result.currentState?.rotationKeys).toEqual(mode === 'protect' ? [f.owner.did()] : f.genesis.rotationKeys);
    expect(result.currentState?.services.hail).toEqual(mode === 'protect' ? undefined : f.genesis.services.hail);
    await f.service.submit(f.alert.id, plan.currentCid, operation, mode); expect(f.count()).toBe(1);
    expect(result.approvalAuthority).toBeNull(); // Never silently approve the recovery.
  });
  it('refuses expired windows, mismatched kits, stale review and modified signed plans', async () => {
    const f = await fixture(), cid = await operationCid(f.update), mode = 'restore';
    await expect(recoveryPlan(f.did, f.audit, cid, f.provider.did(), f.kit.vault.identity.publicDidKey, mode)).rejects.toThrow('highest-priority');
    await expect(recoveryPlan(f.did, f.audit, cid, f.owner.did(), f.kit.vault.identity.publicDidKey, mode, Date.now() + 73 * 3600_000)).rejects.toThrow('closed');
    const plan = await recoveryPlan(f.did, f.audit, cid, f.owner.did(), f.kit.vault.identity.publicDidKey, mode);
    const operation = await signRecovery(f.did, f.audit, cid, f.kit.vault, encodeBase64Url(f.kit.recoverySecret), plan.operation, mode);
    await expect(f.service.submit(f.alert.id, f.genesisCid, operation, mode)).rejects.toThrow('changed since');
    await expect(f.service.submit(f.alert.id, plan.currentCid, { ...operation, alsoKnownAs: ['https://injected.example'] }, mode)).rejects.toThrow('differs');
    expect(f.count()).toBe(0);
  });
  it('recovers a terminal tombstone using the validated fork, without pretending monitoring was healthy', async () => {
    const f = await fixture();
    const operation = await addSignature({ type: 'plc_tombstone' as const, prev: await operationCid(f.update) }, f.provider);
    f.audit.push({ did: f.did, operation, cid: await operationCid(operation), nullified: false, createdAt: new Date(Date.now()-1000).toISOString() });
    await f.monitor.pollDid(f.did);
    const alert = (await db.sql`SELECT id FROM monitor_alerts WHERE did=${f.did} AND category='invalid-operation-log'`)[0];
    const snapshot = await f.service.snapshot(alert.id);
    expect(snapshot.currentState).toBeNull(); expect(snapshot.monitorReady).toBe(false);
    const plan = await recoveryPlan(f.did, snapshot.audit, snapshot.recoveryCid, f.owner.did(), f.kit.vault.identity.publicDidKey, 'restore');
    const signed = await signRecovery(f.did, snapshot.audit, snapshot.recoveryCid, f.kit.vault, encodeBase64Url(f.kit.recoverySecret), plan.operation, 'restore');
    const outcome = await f.service.submit(alert.id, plan.currentCid, signed, 'restore');
    expect(outcome.recovery?.observed).toBe(true);
    expect(outcome.currentState?.services.hail?.endpoint).toBe('https://wrong.example/hail'); // Restores its exact parent, not a guessed baseline.
  });
  it('keeps incident evidence available during directory outage and disables mutations', async () => {
    const f = await fixture();
    f.audit[1]!.cid = f.genesisCid;
    const value = await f.service.snapshot(f.alert.id, true);
    expect(value.directoryVerified).toBe(false); expect(value.recoveryCid).toBeNull();
    expect(value.summary).toContain('identity operation');
    await expect(f.service.approve(f.alert.id, f.genesisCid, 'wrong')).rejects.toThrow();
    expect((await f.post('recover', { currentCid: f.genesisCid, operation: f.update, mode: 'restore' })).status).toBe(401);
  });
  it('rejects an operation signed by top authority and detects changed history', async () => {
    const f = await fixture();
    const { sig, ...unsigned } = f.update;
    const operation = await signOperation(unsigned, f.owner);
    f.audit[1] = { ...f.audit[1]!, operation, cid: await operationCid(operation) };
    await expect(recoveryPlan(f.did, f.audit, f.audit[1].cid, f.owner.did(), f.kit.vault.identity.publicDidKey, 'restore'))
      .rejects.toThrow('top recovery authority');
    await expect(f.service.snapshot(f.alert.id)).rejects.toThrow('regressed');
  });
  it('invalidates authorization when monitoring stops', async () => {
    const f = await fixture(), session = await f.caps.redeem(f.alert.id, f.token);
    await db.sql`UPDATE monitored_dids SET stopped_at=now() WHERE did=${f.did}`;
    expect(await f.caps.authorized(f.alert.id, session!)).toBe(false);
    await expect(f.service.snapshot(f.alert.id)).rejects.toThrow('unavailable');
  });
});
