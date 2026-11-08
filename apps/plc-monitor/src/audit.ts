import { encode } from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { assureValidNextOp, def, validateOperationLog, type ExportedOp, type IndexedOperation } from '@did-plc/lib';

export async function operationCid(value: unknown): Promise<string> {
  return CID.createV1(0x71, await sha256.digest(encode(value))).toString();
}

// Shared browser/server validation, including recovery branches and terminal tombstones.
export async function validateAudit(did: string, source: readonly unknown[], now = Date.now()) {
  if (!/^did:plc:[a-z2-7]{24}$/.test(did) || !source.length || source.length > 1000)
    throw new Error('PLC audit is incomplete or exceeds the monitor limit');
  const audit = source.map(entry => def.exportedOp.strict().parse(entry));
  const history: IndexedOperation[] = [], seen = new Set<string>();
  let previousTime = -Infinity;
  for (const entry of audit) {
    const cid = CID.parse(await operationCid(entry.operation)), createdAt = new Date(entry.createdAt);
    if (entry.did !== did || cid.toString() !== entry.cid || seen.has(entry.cid) ||
        !Number.isFinite(createdAt.getTime()) || createdAt.getTime() < previousTime || createdAt.getTime() > now + 300_000)
      throw new Error('PLC audit bytes or annotations are invalid');
    const accepted = await assureValidNextOp(did, history.filter(op => !op.nullified), entry.operation, createdAt);
    for (const nullified of accepted.nullified) {
      const prior = history.find(op => op.cid.equals(nullified));
      if (!prior) throw new Error('PLC audit recovery is incomplete');
      prior.nullified = true;
    }
    history.push({ did, cid, operation: entry.operation, createdAt, nullified: false });
    seen.add(entry.cid); previousTime = createdAt.getTime();
  }
  if (history.some((entry, index) => entry.nullified !== audit[index]!.nullified))
    throw new Error('PLC audit nullification is invalid');
  const active = history.filter(entry => !entry.nullified);
  return { cid: active.at(-1)!.cid.toString(), state: await validateOperationLog(did, active.map(entry => entry.operation)), audit, active };
}

export function assertAuditContinuity(previous: readonly ExportedOp[], current: readonly ExportedOp[]) {
  // Preserve insertion order as well as bytes/timestamps and irreversible nullification.
  let cursor = 0;
  for (const prior of previous) {
    const next = current[cursor++];
    if (!next || prior.cid !== next.cid || prior.did !== next.did || prior.createdAt !== next.createdAt ||
        JSON.stringify(encode(prior.operation)) !== JSON.stringify(encode(next.operation)) || prior.nullified && !next.nullified)
      throw new Error('PLC audit history regressed');
  }
}
