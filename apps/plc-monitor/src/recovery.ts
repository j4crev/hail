import { assureValidNextOp, assureValidSig, normalizeOp, signOperation, type Operation, type UnsignedOperation } from '@did-plc/lib';
import { P256Keypair } from '@atproto/crypto';
import { decodeBase64Url } from '@racrproto/codec/base64url';
import { cipher, unseal, validateVault, verifyUserVault, type UserVaultFile } from '@racrproto/client-support/vault-crypto';
import { readRecoveryPackage } from '@racrproto/client-support/recovery-package';
import { operationCid, validateAudit } from './audit.js';

export async function recoveryVault(text: string, did: string): Promise<UserVaultFile> {
  if (new TextEncoder().encode(text).length > 98_304) throw new Error('Recovery kit is too large');
  const raw = JSON.parse(text);
  const vault = raw?.type === 'hail.recovery-package' ? (await readRecoveryPackage(text)).vault : raw;
  validateVault(vault);
  if (vault.did !== did) throw new Error('Choose the recovery kit for this identity');
  return vault;
}

export type RecoveryMode = "restore" | "protect";

export async function recoveryPlan(did: string, audit: readonly unknown[], incidentCid: string,
  recoveryKey: string, identityKey: string, mode: RecoveryMode, now = Date.now()) {
  const validated = await validateAudit(did, audit, now);
  const disputed = validated.active.find(entry => entry.cid.toString() === incidentCid);
  if (!disputed || !disputed.operation.prev) throw new Error('This change is already nullified or has no recoverable parent');
  const parent = validated.active.find(entry => entry.cid.toString() === disputed.operation.prev);
  if (!parent || parent.operation.type === 'plc_tombstone') throw new Error('The recovery parent is unavailable');
  const baseline = normalizeOp(parent.operation);
  if (baseline.rotationKeys[0] !== recoveryKey) throw new Error('This kit does not hold the highest-priority recovery key at the fork');
  const signer = await assureValidSig(baseline.rotationKeys, disputed.operation);
  if (baseline.rotationKeys.indexOf(signer) <= 0) throw new Error('This operation was signed with top recovery authority; this kit cannot override it');
  const deadline = disputed.createdAt.getTime() + 72 * 3600_000;
  if (now >= deadline) throw new Error('The 72-hour recovery window for this change has closed');
  if (mode !== 'restore' && mode !== 'protect') throw new Error('Invalid recovery choice');
  // Protect only the Hail surface; retain unrelated applications exactly as reviewed.
  const verificationMethods = { ...baseline.verificationMethods, 'hail-identity': identityKey };
  if (mode === 'protect') delete (verificationMethods as Record<string, string>)['hail-messaging'];
  const services = { ...baseline.services }; if (mode === 'protect') delete services.hail;
  const operation: UnsignedOperation = { type: 'plc_operation', prev: parent.cid.toString(),
    rotationKeys: mode === 'protect' ? [recoveryKey] : baseline.rotationKeys,
    verificationMethods: mode === 'protect' ? verificationMethods : baseline.verificationMethods, services, alsoKnownAs: baseline.alsoKnownAs };
  return { operation, currentCid: validated.cid, deadline: new Date(deadline).toISOString(), audit: validated };
}

export async function signRecovery(did: string, audit: readonly unknown[], incidentCid: string,
  vault: UserVaultFile, secretText: string, reviewed: UnsignedOperation, mode: RecoveryMode, now = Date.now()): Promise<Operation> {
  validateVault(vault);
  if (vault.did !== did) throw new Error('Recovery kit identity mismatch');
  const plan = await recoveryPlan(did, audit, incidentCid, vault.recovery.publicDidKey, vault.identity.publicDidKey, mode, now);
  if (await operationCid(plan.operation) !== await operationCid(reviewed)) throw new Error('Recovery plan changed; review it again');
  const secret = decodeBase64Url(secretText, 32);
  let privateBytes: Uint8Array | undefined;
  try {
    await verifyUserVault(vault, secret);
    privateBytes = await unseal(await cipher(secret), vault.recovery, 'user-recovery');
    const key = await P256Keypair.import(privateBytes);
    const signed = await signOperation(plan.operation, key);
    await assureValidNextOp(did, plan.audit.active, signed, new Date(now));
    return signed;
  } finally { secret.fill(0); privateBytes?.fill(0); }
}
