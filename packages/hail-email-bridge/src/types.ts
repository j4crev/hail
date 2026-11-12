/** Text blocks are exactly `spt-2` text blocks, so the codec can validate them unchanged. */
export type TextStyle = "normal" | "h1" | "h2" | "h3" | "blockquote" | "caption" | "cta";
export type Decorator = "strong" | "em" | "code";

export interface BridgeSpan { _type: "span"; text: string; marks: string[] }
export interface BridgeLink { _key: string; _type: "spt.link"; href: string }
export interface BridgeTextBlock {
  _type: "block";
  style: TextStyle;
  children: BridgeSpan[];
  markDefs: BridgeLink[];
  listItem?: "bullet" | "number";
  level?: 1 | 2 | 3;
  alignment?: "center" | "right";
}

/**
 * An image the email referenced. It is not an SPT node: a later stage fetches or
 * resolves the bytes, validates them and either bundles the image or replaces
 * this reference with a text link.
 */
export interface BridgeImageRef {
  _type: "bridge.image";
  source: { kind: "remote"; url: string } | { kind: "inline"; contentId: string };
  /** Cleaned alternative text, or null when the email supplied none. */
  alt: string | null;
  declaredWidth?: number;
  declaredHeight?: number;
  /** HTTPS destination when the image was inside a link. */
  link?: string;
}

export type BridgeBlock = BridgeTextBlock | BridgeImageRef;

export type DiagnosticCode =
  | "html-too-large"
  | "html-missing"
  | "hidden-content-dropped"
  | "unsupported-element-dropped"
  | "link-dropped-non-https"
  | "link-dropped-mailto"
  | "link-dropped-invalid"
  | "image-dropped-non-https"
  | "image-dropped-data-uri"
  | "image-dropped-invalid"
  | "tracking-pixel-dropped"
  | "image-unavailable"
  | "image-linked-unsupported"
  | "image-linked-too-large"
  | "image-linked-budget"
  | "data-table-flattened"
  | "rule-dropped"
  | "list-level-clamped"
  | "nesting-too-deep"
  | "attachment-dropped"
  | "truncated";

export type Diagnostics = Partial<Record<DiagnosticCode, number>>;

export interface InlineImage { mediaType: string; bytes: Uint8Array }

export interface EmailSource {
  fromAddress: string;
  fromName?: string;
  subject?: string;
  listId?: string;
  messageId?: string;
  /** RFC 3339 UTC timestamp from the Date header, when it parsed. */
  date?: string;
}

export interface ConvertedEmail {
  source: EmailSource;
  blocks: BridgeBlock[];
  /** Inline MIME image parts by content ID, for `source.kind === "inline"`. */
  inlineImages: Map<string, InlineImage>;
  diagnostics: Diagnostics;
}

export type BridgeInputErrorCode = "message-too-large" | "unparseable" | "missing-sender" | "empty";

/** The message cannot be converted at all. Never thrown for merely lossy content. */
export class BridgeInputError extends Error {
  constructor(readonly code: BridgeInputErrorCode, message: string) { super(message); this.name = "BridgeInputError"; }
}
