import { blockItems, blockTextBytes, utf8Length, type ConversionLimits } from "./limits.ts";
import { cleanSpanText } from "./text.ts";
import type {
  BridgeBlock, BridgeImageRef, BridgeLink, BridgeSpan, BridgeTextBlock, Decorator, DiagnosticCode, Diagnostics, TextStyle,
} from "./types.ts";

export interface BlockShape {
  style: TextStyle;
  listItem?: "bullet" | "number";
  level?: 1 | 2 | 3;
  alignment?: "center" | "right";
  /** Render as a call to action when the finished block qualifies. */
  callToAction?: boolean;
}

export interface TextOptions {
  decorators: ReadonlySet<Decorator>;
  href: string | null;
  /** Keep whitespace and line breaks exactly, as in `<pre>`. */
  preserve: boolean;
}

const DECORATOR_ORDER: readonly Decorator[] = ["strong", "em", "code"];
export const TRUNCATION_NOTICE = "The email bridge shortened this message.";

interface OpenBlock { shape: BlockShape; spans: BridgeSpan[]; links: Map<string, string>; text: string }

/**
 * Accumulates inline text into blocks and enforces the conversion budgets.
 * Once a budget is exhausted the builder stops accepting content and ends the
 * output with a visible notice.
 */
export class BlockBuilder {
  readonly diagnostics: Diagnostics = {};
  private readonly blocks: BridgeBlock[] = [];
  private open: OpenBlock | null = null;
  private items = 0;
  private textBytes = 0;
  private full = false;

  constructor(private readonly limits: ConversionLimits) {}

  get truncated(): boolean { return this.full; }

  note(code: DiagnosticCode, count = 1): void {
    this.diagnostics[code] = (this.diagnostics[code] ?? 0) + count;
  }

  /** True when the open block already holds visible text. */
  get hasOpenText(): boolean { return this.open !== null && this.open.text.length > 0; }

  text(raw: string, shape: BlockShape, options: TextOptions): void {
    if (this.full) return;
    let value = cleanSpanText(raw);
    if (!options.preserve) value = value.replace(/[\s ]+/g, " ");
    const existing = this.open?.text ?? "";
    if (!options.preserve) {
      if (existing === "" || /[ \n]$/.test(existing)) value = value.replace(/^ +/, "");
    } else if (existing === "") value = value.replace(/^\n+/, "");
    if (!value) return;
    if (this.open && this.open.spans.length >= this.limits.maxSpansPerBlock) this.flush();
    // The first visible text fixes the block's shape.
    const open: OpenBlock = this.open ??= { shape, spans: [], links: new Map(), text: "" };

    const marks: string[] = DECORATOR_ORDER.filter(decorator => options.decorators.has(decorator));
    if (options.href) {
      let key = open.links.get(options.href);
      if (!key) { key = `l${open.links.size + 1}`; open.links.set(options.href, key); }
      marks.push(key);
    }
    const last = open.spans.at(-1);
    if (last && last.marks.length === marks.length && last.marks.every((mark, index) => mark === marks[index])) last.text += value;
    else open.spans.push({ _type: "span", text: value, marks });
    open.text += value;
  }

  /** A line break. Two in a row end the paragraph, as email authors intend. */
  lineBreak(): void {
    const open = this.open;
    if (this.full || !open || open.text === "") return;
    if (open.text.endsWith("\n")) { this.flush(); return; }
    const last = open.spans.at(-1)!;
    last.text = last.text.replace(/ +$/, "") + "\n";
    open.text = open.text.replace(/ +$/, "") + "\n";
  }

  flush(): void {
    const open = this.open;
    this.open = null;
    if (!open || this.full) return;
    // Trailing whitespace belongs to no span once the block ends.
    while (open.spans.length) {
      const last = open.spans.at(-1)!;
      last.text = last.text.replace(/[ \n]+$/, "");
      if (last.text) break;
      open.spans.pop();
    }
    if (!open.spans.length) return;
    const used = new Set(open.spans.flatMap(span => span.marks));
    const markDefs: BridgeLink[] = [...open.links].filter(([, key]) => used.has(key))
      .map(([href, key]) => ({ _key: key, _type: "spt.link", href }));
    this.push(finishBlock(open.shape, open.spans, markDefs));
  }

  image(reference: BridgeImageRef): void {
    this.flush();
    this.push(reference);
  }

  finish(): BridgeBlock[] {
    this.flush();
    if (this.full) {
      this.note("truncated");
      this.blocks.push(plainBlock(TRUNCATION_NOTICE, "caption"));
    }
    return this.blocks;
  }

  private push(block: BridgeBlock): void {
    if (this.full) return;
    const items = blockItems(block), bytes = blockTextBytes(block);
    // One block and its items stay reserved for the truncation notice.
    if (this.blocks.length + 2 > this.limits.maxBlocks || this.items + items + NOTICE_ITEMS > this.limits.maxItems ||
      this.textBytes + bytes + NOTICE_BYTES > this.limits.maxTextBytes) { this.full = true; return; }
    this.items += items; this.textBytes += bytes;
    this.blocks.push(block);
  }
}

export function plainBlock(text: string, style: TextStyle = "normal"): BridgeTextBlock {
  return { _type: "block", style, children: [{ _type: "span", text, marks: [] }], markDefs: [] };
}

const NOTICE_ITEMS = blockItems(plainBlock(TRUNCATION_NOTICE, "caption"));
const NOTICE_BYTES = utf8Length(TRUNCATION_NOTICE);

function finishBlock(shape: BlockShape, spans: BridgeSpan[], markDefs: BridgeLink[]): BridgeTextBlock {
  if (shape.callToAction && markDefs.length === 1) {
    const key = markDefs[0]!._key;
    const label = spans.map(span => span.text).join("").replace(/\n+/g, " ");
    // The profile requires one undecorated link over a single line of 1 to 128 bytes.
    if (spans.every(span => span.marks.includes(key)) && label.trim() && utf8Length(label) <= 128) {
      const block: BridgeTextBlock = {
        _type: "block", style: "cta", children: [{ _type: "span", text: label, marks: [key] }], markDefs,
      };
      if (shape.alignment) block.alignment = shape.alignment;
      return block;
    }
  }
  const block: BridgeTextBlock = { _type: "block", style: shape.style, children: spans, markDefs };
  if (shape.listItem) { block.listItem = shape.listItem; block.level = shape.level ?? 1; }
  if (shape.alignment) block.alignment = shape.alignment;
  return block;
}
