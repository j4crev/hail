import { CID } from "multiformats/cid";

export const RECEIVER_LIFECYCLE_CONTEXT = "hail.plc-monitor-receiver-lifecycle.v1\0";
export const RECEIVER_LIFECYCLE_PATH = "/hail/signup/lifecycle";
export interface ReceiverLifecycle {
  type: "hail.plc-monitor-receiver-lifecycle"; version: 1;
  did: string; operationCid: string; action: "claim" | "stop"; issuedAt: number;
}
export function checkReceiverLifecycle(value: unknown, now: number): asserts value is ReceiverLifecycle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid lifecycle request");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "action,did,issuedAt,operationCid,type,version" ||
    row.type !== "hail.plc-monitor-receiver-lifecycle" || row.version !== 1 ||
    row.action !== "claim" && row.action !== "stop" || typeof row.did !== "string" || !/^did:plc:[a-z2-7]{24}$/.test(row.did) ||
    typeof row.operationCid !== "string" || typeof row.issuedAt !== "number" || !Number.isSafeInteger(row.issuedAt) ||
    Math.abs(row.issuedAt - now) > 300) throw Error("Invalid lifecycle request");
  const cid = CID.parse(row.operationCid);
  if (cid.toString() !== row.operationCid || cid.code !== 0x71 || cid.multihash.code !== 0x12 || cid.multihash.digest.length !== 32)
    throw Error("Invalid lifecycle CID");
}
