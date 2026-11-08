import { recoveryVault, recoveryPlan, signRecovery, type RecoveryMode } from './recovery.js';
import type { IncidentService } from './incidents.js';
import type { Operation } from '@did-plc/lib';

type Snapshot = Awaited<ReturnType<IncidentService['snapshot']>>;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const id = location.pathname.split('/')[2]!;
let token = new URL(location.href).searchParams.get('token') ?? '';
history.replaceState(null, '', location.pathname); // Remove the bearer before any further requests.
let snapshot: Snapshot | undefined;
let prepared: { vault: Awaited<ReturnType<typeof recoveryVault>>; plan: Awaited<ReturnType<typeof recoveryPlan>>; mode: RecoveryMode } | undefined;
let pending: { operation: Operation; currentCid: string; mode: RecoveryMode } | undefined;
const say = (text: string) => { el('message').textContent = text; };
function clearPlan() { prepared = undefined; el('plan').hidden = true; input('secret').value = ''; input('recover-confirm').checked = false; }
async function request(action: string, body?: unknown) {
  const response = await fetch(`/incidents/${id}/${action}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}
function render(value: Snapshot) {
  snapshot = value; clearPlan();
  el('entry').hidden = true; el('incident').hidden = false;
  el('status').textContent = `Operation: ${value.operationStatus}. ${value.currentCid === value.expectedCid ? 'Current configuration matches the monitor baseline.' : 'Current configuration differs from the monitor baseline.'}${value.approvalAuthority === 'email-capability' ? ' Recognized using an email capability.' : ''}`;
  el('health').textContent = `${value.directoryVerified ? 'Directory history verified ' + value.checkedAt : 'Directory history unavailable or invalid; all changes are disabled'}. Regular monitor: ${value.monitorReady ? 'ready' : 'not ready'}; last successful poll ${value.lastMonitorPollAt ?? 'unavailable'}. Earlier coverage gaps remain in the record.`;
  el('summary').textContent = value.summary;
  el('current').textContent = JSON.stringify(value.currentState, null, 2);
  el('evidence').textContent = JSON.stringify({ did: value.did, detail: value.detail, currentCid: value.currentCid, audit: value.audit }, null, 2);
  el('recognition').hidden = value.operationStatus !== 'current' || value.currentCid === value.expectedCid || !value.currentState;
  input('recognize-confirm').checked = false;
  el('recovery').hidden = !value.recoveryCid || value.operationStatus === 'nullified' || Boolean(value.recovery) || Boolean(pending);
  el('outcome').hidden = !value.recovery && !pending;
  if (pending && !value.recovery) {
    el('result').textContent = 'Signed on this device, but server acceptance is not confirmed. Retry these exact bytes; do not sign a different correction.';
    el('retry').hidden = false;
  }
  if (value.recovery) {
    pending = { operation: value.recovery.operation, currentCid: value.recovery.reviewedCurrentCid, mode: value.recovery.mode };
    el('result').textContent = value.recovery.observed
      ? `PLC recovery observed.${value.recovery.current ? ' The recovery operation is current.' : ' A later operation is now current; review it.'} ${value.recovery.mode === 'protect' ? 'Hail service is suspended.' : 'The previous provider configuration was restored.'} Provider account availability has not been verified. Review sessions and credentials with the provider; PLC recovery does not revoke them or undo earlier activity.`
      : 'A signed operation is saved, but recovery has not been confirmed on the active PLC history. Refresh status or retry these exact bytes. Do not assume success or create a different operation.';
    el('retry').hidden = value.recovery.observed;
  }
}
async function busy(fn: () => Promise<void>) {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(button => { button.disabled = true; });
  try { say(''); await fn(); } catch (error) { say(error instanceof Error ? error.message : 'Action failed'); }
  finally { input('secret').value = ''; document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(button => { button.disabled = false; }); }
}
el('open').onclick = () => void busy(async () => { await request('redeem', { token }); render(await request('data')); });
el('renew').onclick = () => void busy(async () => { say((await request('renew', { token })).message); });
el('refresh').onclick = () => void busy(async () => { render(await request('data')); });
el('recognize').onclick = () => void busy(async () => {
  if (!snapshot || !input('recognize-confirm').checked) throw new Error('Confirm that you reviewed and recognize this exact state.');
  await request('approve', { cid: snapshot.currentCid, digest: snapshot.currentDigest });
  render(await request('data')); say('Change recognized. Incident evidence remains retained.');
});
input('kit').onchange = clearPlan;
document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach(radio => { radio.onchange = clearPlan; });
el('prepare').onclick = () => void busy(async () => {
  clearPlan();
  const file = input('kit').files?.[0];
  if (!file || file.size > 98_304) throw new Error('Choose a recovery kit of at most 96 KiB.');
  render(await request('data'));
  const value = snapshot!;
  const vault = await recoveryVault(await file.text(), value.did);
  const mode = document.querySelector<HTMLInputElement>('input[name=mode]:checked')!.value as RecoveryMode;
  const plan = await recoveryPlan(value.did, value.audit, value.recoveryCid, vault.recovery.publicDidKey, vault.identity.publicDidKey, mode);
  prepared = { vault, mode, plan };
  el('plan').hidden = false;
  el('deadline').textContent = `Choice: ${mode === 'restore' ? 'Restore previous configuration' : 'Protect identity and suspend Hail service'}. Recovery deadline: ${plan.deadline}. Eligibility is checked again before submission. This kit names the required key; its secret is checked when signing.`;
  el('proposed').textContent = JSON.stringify(plan.operation, null, 2);
});
el('submit').onclick = () => void busy(async () => {
  if (!prepared || !snapshot || !input('recover-confirm').checked) throw new Error('Review and confirm the recovery correction first.');
  const secret = input('secret').value.trim(); input('secret').value = '';
  const value = await request('data') as Snapshot;
  if (value.currentCid !== prepared.plan.currentCid) { clearPlan(); throw new Error('Identity changed. Review a new recovery plan.'); }
  const operation = await signRecovery(value.did, value.audit, value.recoveryCid, prepared.vault, secret, prepared.plan.operation, prepared.mode);
  pending = { operation, currentCid: value.currentCid, mode: prepared.mode };
  clearPlan();
  render(value); // Keep an exact-byte retry available even if the first POST fails.
  // Public signed bytes may be retained for exact retry; keys and the kit are never uploaded.
  render(await request('recover', pending));
});
el('retry').onclick = () => void busy(async () => { if (pending) render(await request('recover', pending)); });
window.addEventListener('pagehide', () => { clearPlan(); token = ''; input('kit').value = ''; snapshot = undefined; });
void request('data').then(render).catch(() => { if (!token) say('Reopen the private link in your alert email.'); });
