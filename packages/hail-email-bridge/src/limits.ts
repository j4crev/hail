import type { BridgeBlock } from "./types.ts";

export interface ConversionLimits {
  /** Raw RFC 5322 message bytes accepted for parsing. */
  maxMessageBytes: number;
  /** HTML part size above which the plain-text part is used instead. */
  maxHtmlBytes: number;
  /** Element nesting below which content is still converted. */
  maxDepth: number;
  /** Text and image blocks emitted, including the truncation notice. */
  maxBlocks: number;
  /** CBOR items the emitted blocks may occupy, counted as in spec/encoding.md. */
  maxItems: number;
  /** UTF-8 bytes of span text and link destinations. */
  maxTextBytes: number;
  /** Spans in one block. */
  maxSpansPerBlock: number;
}

/**
 * Defaults stay inside the current body budgets in spec/encoding.md (4096 array
 * elements, 16384 items, 1 MiB) with room left for the body wrapper, the asset
 * manifest and the origin field. They are structural ceilings, not the image
 * limits, which a later stage applies.
 */
export const DEFAULT_LIMITS: ConversionLimits = {
  maxMessageBytes: 25 * 1024 * 1024,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxDepth: 256,
  maxBlocks: 2048,
  maxItems: 14_000,
  maxTextBytes: 512 * 1024,
  maxSpansPerBlock: 1024,
};

/** For measurement only: report what a message needs instead of truncating it. */
export const UNBOUNDED_LIMITS: ConversionLimits = {
  ...DEFAULT_LIMITS,
  maxHtmlBytes: 16 * 1024 * 1024,
  maxBlocks: Number.MAX_SAFE_INTEGER,
  maxItems: Number.MAX_SAFE_INTEGER,
  maxTextBytes: Number.MAX_SAFE_INTEGER,
};

/** An image block (7 items) plus its manifest entry with a digest map (23 items). */
const IMAGE_ITEMS = 30;

/** CBOR item count: one per scalar, array or map, plus one per map key. */
function valueItems(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + valueItems(entry), 1);
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((sum, entry) => sum + 1 + valueItems(entry), 1);
  }
  return 1;
}

export function blockItems(block: BridgeBlock): number {
  return block._type === "bridge.image" ? IMAGE_ITEMS : valueItems(block);
}

const encoder = new TextEncoder();
export const utf8Length = (value: string): number => encoder.encode(value).length;

export function blockTextBytes(block: BridgeBlock): number {
  if (block._type === "bridge.image") return utf8Length(block.alt ?? "") + utf8Length(block.link ?? "");
  return block.children.reduce((sum, span) => sum + utf8Length(span.text), 0) +
    block.markDefs.reduce((sum, link) => sum + utf8Length(link.href), 0);
}
