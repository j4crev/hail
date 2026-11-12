import { dkimVerify } from "mailauth/lib/dkim/verify";
import type { DkimCheck } from "./converter.js";

/** DNS lookup in the shape the DKIM verifier expects, so tests can supply records. */
export type TxtResolver = (domain: string, type: string) => Promise<string[][] | string[]>;

/**
 * `dkim-aligned` when at least one signature verifies and its signing domain is
 * the author's domain or shares its registrable domain (spec/bodies.md). The
 * message must have exactly one From address, and it must be the one the
 * converter read; otherwise the signature says nothing about that author.
 */
export function createDkimCheck(resolver?: TxtResolver, now: () => Date = () => new Date()): DkimCheck {
  return async (raw, fromAddress) => {
    const result = await dkimVerify(Buffer.from(raw), { curTime: now(), minBitLength: 1024, ...(resolver ? { resolver } : {}) });
    if (result.fromFields !== 1 || result.headerFrom.length !== 1 || result.headerFrom[0]?.toLowerCase() !== fromAddress) return "none";
    return result.results.some(signature => signature.status.result === "pass" && signature.status.aligned) ? "dkim-aligned" : "none";
  };
}
