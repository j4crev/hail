import { open, stat } from 'node:fs/promises';
import { recoveryVault, recoveryPlan, signRecovery, type RecoveryMode } from '../recovery.js';
import { BoundedMonitorPlcClient } from '../plc.js';
import { operationCid, validateAudit } from '../audit.js';

// Independent workstation workflow. No monitor, provider login or email capability.
// The directory is fixed: a kit cannot be redirected to a caller-selected server.
const [command, ...args] = Bun.argv.slice(2);
const plc = new BoundedMonitorPlcClient('https://plc.directory');
async function read(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > limit) throw Error('Input must be a bounded regular file');
  return Bun.file(path).text();
}
async function save(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
}
if (command === 'plan' && args.length === 5) {
  const [did, incidentCid, kitPath, mode, out] = args as [string, string, string, RecoveryMode, string];
  const vault = await recoveryVault(await read(kitPath, 98_304), did);
  const audit = await plc.getAuditableLog(did);
  const plan = await recoveryPlan(did, audit, incidentCid, vault.recovery.publicDidKey, vault.identity.publicDidKey, mode);
  await save(out, { did, incidentCid, mode, currentCid: plan.currentCid, operation: plan.operation });
  console.info(`Review ${out}. ${mode === 'restore' ? 'Restores previous provider authority and configuration; provider internal repairs may still be needed.' : 'Removes provider rotation authority and suspends Hail service; does not transfer your account.'} Both choices nullify the disputed branch, including later changes. Deadline: ${plan.deadline}`);
} else if (command === 'sign' && args.length === 4 && args[3] === '--approve-reviewed-plan') {
  const [planPath, kitPath, out] = args as [string, string, string, string];
  const plan = JSON.parse(await read(planPath, 16_384));
  const vault = await recoveryVault(await read(kitPath, 98_304), plan.did);
  const audit = await plc.getAuditableLog(plan.did);
  if ((await validateAudit(plan.did, audit)).cid !== plan.currentCid) throw Error('Identity changed; prepare and review a new plan');
  if (process.stdin.isTTY) throw Error('Read the recovery secret from protected stdin, not a command argument or echoing terminal');
  const reader = Bun.stdin.stream().getReader();
  let secret = '';
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      secret += new TextDecoder().decode(next.value); if (secret.length > 128) throw Error('Invalid secret input'); }
    const operation = await signRecovery(plan.did, audit, plan.incidentCid, vault, secret.trim(), plan.operation, plan.mode);
    await save(out, { did: plan.did, currentCid: plan.currentCid, operation, cid: await operationCid(operation) });
    console.info(`Signed operation saved to ${out}; nothing submitted. Keep this file for exact retries.`);
  } finally { secret = ''; await reader.cancel(); }
} else if (command === 'submit' && args.length === 1) {
  const signed = JSON.parse(await read(args[0]!, 16_384));
  const cid = await operationCid(signed.operation);
  if (signed.cid !== cid) throw Error('Signed operation CID mismatch');
  let current = await validateAudit(signed.did, await plc.getAuditableLog(signed.did));
  if (!current.audit.some(entry => entry.cid === cid)) {
    if (current.cid !== signed.currentCid) throw Error('Identity changed; inspect before submitting');
    const { assureValidNextOp, def } = await import('@did-plc/lib');
    await assureValidNextOp(signed.did, current.active, def.operation.parse(signed.operation), new Date());
    try { await plc.submitOperation(signed.did, signed.operation); } catch { /* Reconcile ambiguous submission. */ }
    current = await validateAudit(signed.did, await plc.getAuditableLog(signed.did));
  }
  if (!current.audit.some(entry => entry.cid === cid && !entry.nullified)) throw Error('Recovery not confirmed; retain the exact signed file and retry/check history');
  console.info(`Recovery observed: ${cid}. ${current.cid === cid ? 'Currently effective.' : 'Later changes exist; review them.'} Provider account availability is not verified.`);
} else {
  throw Error('Usage: recover.ts plan DID INCIDENT_CID KIT restore|protect NEW_PLAN; sign PLAN KIT NEW_SIGNED --approve-reviewed-plan < protected-secret-file; submit SIGNED');
}
