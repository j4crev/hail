import { createHash } from "node:crypto";
import { parseDictionary } from "structured-headers";

/** Transport integrity only; callers must still verify the signed content digest. */
export function validateContentDigest(header: string | null, wire: Uint8Array): boolean {
  if (header === null) return true;
  // Bound parsing/allocation before invoking the general Structured Fields parser.
  if (header.length > 8192 || /[^\x20-\x7e\t]/.test(header)) return false;
  try {
    const dictionary = parseDictionary(header);
    if (dictionary.size > 16) return false;
    for (const [algorithm, [value]] of dictionary) {
      if (!(value instanceof ArrayBuffer)) return false;
      // Unknown algorithms and parameters are ignored, not used as authority.
      if (algorithm !== "sha-256" && algorithm !== "sha-512") continue;
      const expected = createHash(algorithm === "sha-256" ? "sha256" : "sha512").update(wire).digest();
      if (!expected.equals(Buffer.from(value))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
