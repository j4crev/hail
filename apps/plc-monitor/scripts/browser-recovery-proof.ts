import { createUserVault, cipher, unseal } from '@racrproto/client-support/vault-crypto';
import { P256Keypair } from '@atproto/crypto';
import { didForCreateOp, signOperation, assureValidNextOp } from '@did-plc/lib';
import { encodeBase64Url } from '@racrproto/codec/base64url';
import { recoveryPlan, signRecovery } from '../src/recovery.js';
import { operationCid, validateAudit } from '../src/audit.js';

try {
  const kit = await createUserVault(), provider = await P256Keypair.create();
  const raw = await unseal(await cipher(kit.recoverySecret), kit.vault.recovery, 'user-recovery');
  const owner = await P256Keypair.import(raw);
  const unsigned = { type: 'plc_operation' as const, prev: null, rotationKeys: [owner.did(), provider.did()],
    verificationMethods: { 'hail-identity': kit.vault.identity.publicDidKey },
    services: { hail: { type: 'HailMessaging', endpoint: 'https://provider.example/hail' } }, alsoKnownAs: [] };
  const genesis = await signOperation(unsigned, owner), did = await didForCreateOp(genesis); kit.vault.did = did;
  const cid = await operationCid(genesis);
  const update = await signOperation({ ...unsigned, prev: cid, alsoKnownAs: ['https://unexpected.example'] }, provider);
  const updatedCid = await operationCid(update);
  const audit = [genesis, update].map((operation, i) => ({ operation, did, cid: i ? updatedCid : cid,
    nullified: false, createdAt: new Date(Date.now() - 60_000 + i * 1000).toISOString() }));
  for (const mode of ['restore','protect'] as const) {
    const plan = await recoveryPlan(did, audit, updatedCid, owner.did(), kit.vault.identity.publicDidKey, mode);
    let rejected = false;
    try { await signRecovery(did, audit, updatedCid, kit.vault, 'A'.repeat(43), plan.operation, mode); } catch { rejected = true; }
    if (!rejected) throw Error('Wrong secret accepted');
    const signed = await signRecovery(did, audit, updatedCid, kit.vault, encodeBase64Url(kit.recoverySecret), plan.operation, mode);
    const accepted = await assureValidNextOp(did, (await validateAudit(did, audit)).active, signed, new Date());
    if (accepted.nullified.length !== 1 || (mode === 'restore') !== Boolean(signed.services.hail)) throw Error('Recovery semantics incorrect');
  }
  raw.fill(0); kit.recoverySecret.fill(0);
  document.body.textContent = 'PASS: browser recovery, both choices, audit validation, local signing and wrong-secret refusal';
} catch (error) { document.body.textContent = `FAIL: ${error instanceof Error ? error.message : 'recovery'}`; }
