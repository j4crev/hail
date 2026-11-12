import { decodeBase64Url, encodeBase64Url } from "./base64url.js";
import { HailCodecError } from "./errors.js";
import { assertHailValue, DEFAULT_HAIL_RESOURCE_LIMITS } from "./cbor.js";
import type { HailPayloadType, HailValue } from "./types.js";
import type { HailPayloadByType } from "./models.js";
import { validatePayload } from "./validation.js";

export type DiagnosticJson =
  | null
  | boolean
  | number
  | string
  | DiagnosticJson[]
  | { [key: string]: DiagnosticJson };

function convertToDiagnostic(value: HailValue, redactSecrets: boolean): DiagnosticJson {
  if (value instanceof Uint8Array) return encodeBase64Url(value);
  if (Array.isArray(value)) {
    return value.map((entry) => convertToDiagnostic(entry, redactSecrets));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, DiagnosticJson> = Object.create(
      null,
    ) as Record<string, DiagnosticJson>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value:
          redactSecrets && key === "token"
            ? "[REDACTED]"
            : convertToDiagnostic(entry, redactSecrets),
        writable: true,
      });
    }
    return output;
  }
  return value;
}

export function toDiagnosticJson<T extends HailPayloadType>(
  type: T,
  value: HailPayloadByType[T],
  redactSecrets = true,
): DiagnosticJson {
  assertHailValue(value);
  validatePayload(type, value);
  return convertToDiagnostic(value, redactSecrets);
}

function fromJson(value: DiagnosticJson, parent?: Record<string, DiagnosticJson>, key?: string): HailValue {
  if (Array.isArray(value)) return value.map((entry) => fromJson(entry));
  if (value !== null && typeof value === "object") {
    const output: Record<string, HailValue> = Object.create(null) as Record<
      string,
      HailValue
    >;
    for (const [childKey, childValue] of Object.entries(value)) {
      Object.defineProperty(output, childKey, {
        configurable: true,
        enumerable: true,
        value: fromJson(childValue, value, childKey),
        writable: true,
      });
    }
    return output;
  }
  if (typeof value === "string") {
    if (key === "token") return decodeBase64Url(value, 32);
    if (key === "previous") return decodeBase64Url(value, 32);
    if (key === "data") return decodeBase64Url(value);
    if (key === "descriptor") return decodeBase64Url(value);
    if (key === "value" && parent?.algorithm === "sha-256") {
      return decodeBase64Url(value, 32);
    }
  }
  return value;
}

const DIAGNOSTIC_INPUT_LIMITS = {
  ...DEFAULT_HAIL_RESOURCE_LIMITS,
  maximumBytes: Math.ceil(DEFAULT_HAIL_RESOURCE_LIMITS.maximumBytes * 4 / 3) + 65_536,
  maximumTextBytes: Math.ceil(DEFAULT_HAIL_RESOURCE_LIMITS.maximumByteStringLength * 4 / 3) + 4,
};

export function fromDiagnosticJson<T extends HailPayloadType>(
  type: T,
  value: DiagnosticJson,
): HailPayloadByType[T] {
  // Byte strings are base64url text in this form, a third larger than the bytes
  // they stand for. Bound the input by that inflated size here; the converted
  // value is held to the real limits by validatePayload below.
  assertHailValue(value, DIAGNOSTIC_INPUT_LIMITS);
  let converted: HailValue;
  try {
    converted = fromJson(value);
  } catch (error) {
    if (error instanceof HailCodecError) throw error;
    throw new HailCodecError(
      "invalid-diagnostic-json",
      error instanceof Error ? error.message : String(error),
    );
  }
  const result: unknown = converted;
  validatePayload(type, result);
  return result;
}
