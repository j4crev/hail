import { dkimVerify } from "mailauth/lib/dkim/verify";
import type { DkimCheck, DkimOutcome } from "./converter.js";

/** DNS lookup in the shape the DKIM verifier expects, so tests can supply records. */
export type TxtResolver = (domain: string, type: string) => Promise<string[][] | string[]>;

/**
 * `dkim-aligned` when at least one signature verifies and its signing domain is
 * the author's domain or shares its registrable domain (spec/bodies.md). The
 * message must have exactly one From address, and it must be the one the
 * converter read; otherwise the signature says nothing about that author.
 *
 * The outcome also lists each signature's domain and result, without message
 * content, so an unverified message can be explained afterwards.
 */
export function createDkimCheck(resolver?: TxtResolver, now: () => Date = () => new Date()): DkimCheck {
  return async (raw, fromAddress) => {
    const result = await dkimVerify(Buffer.from(raw), { curTime: now(), minBitLength: 1024, ...(resolver ? { resolver } : {}) });
    // An unsigned message yields a placeholder result with no signing domain.
    const signatures = result.results.filter(signature => signature.signingDomain).slice(0, 5).map(signature => ({
      domain: String(signature.signingDomain ?? "").slice(0, 253),
      result: signature.status.result,
      aligned: Boolean(signature.status.aligned),
      ...(signature.status.comment ? { comment: String(signature.status.comment).slice(0, 160) } : {}),
    }));
    const outcome = (authentication: DkimOutcome["authentication"], reason?: string): DkimOutcome =>
      ({ authentication, signatures, ...(reason ? { reason } : {}) });
    if (result.fromFields !== 1 || result.headerFrom.length !== 1) return outcome("none", "message does not have exactly one From address");
    if (result.headerFrom[0]?.toLowerCase() !== fromAddress) return outcome("none", "From header differs from the converted sender");
    if (!signatures.length) return outcome("none", "no DKIM signature");
    return result.results.some(signature => signature.status.result === "pass" && signature.status.aligned)
      ? outcome("dkim-aligned") : outcome("none", "no passing signature from the sender's domain");
  };
}
