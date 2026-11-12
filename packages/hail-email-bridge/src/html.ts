import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { BlockBuilder, BlockShape } from "./builder.js";
import { cleanProfileText, httpsDestination } from "./text.js";
import type { BridgeImageRef, Decorator, TextStyle } from "./types.js";

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

/** Never rendered, whatever they contain. */
const SKIPPED = new Set([
  "head", "script", "style", "title", "meta", "link", "base", "noscript", "template", "iframe", "frame", "frameset",
  "object", "embed", "applet", "svg", "math", "canvas", "video", "audio", "source", "track", "map", "area",
  "form", "input", "select", "option", "optgroup", "textarea", "button", "datalist", "dialog",
]);
/** Elements whose start and end separate blocks. */
const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "address", "center", "figure",
  "figcaption", "table", "caption", "thead", "tbody", "tfoot", "tr", "td", "th", "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "details", "summary", "fieldset", "legend",
]);
const HEADING: Record<string, TextStyle> = { h1: "h1", h2: "h2", h3: "h3", h4: "h3", h5: "h3", h6: "h3" };
const STRONG = new Set(["b", "strong"]), EMPHASIS = new Set(["i", "em", "cite", "dfn", "var"]);
const CODE = new Set(["code", "tt", "kbd", "samp"]);

interface Context {
  style: TextStyle;
  list: { type: "bullet" | "number"; level: number } | null;
  inItem: boolean;
  alignment: "center" | "right" | undefined;
  decorators: ReadonlySet<Decorator>;
  href: string | null;
  callToAction: boolean;
  preserve: boolean;
  /** Inherited `font-size:0`: text is invisible until a descendant sets a size. */
  zeroFont: boolean;
  depth: number;
  maxDepth: number;
}

const attribute = (element: Element, name: string): string | undefined =>
  element.attrs.find(entry => entry.name === name)?.value;

function inlineStyle(element: Element): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const part of (attribute(element, "style") ?? "").split(";")) {
    const separator = part.indexOf(":");
    if (separator < 1) continue;
    declarations.set(part.slice(0, separator).trim().toLowerCase(),
      part.slice(separator + 1).replace(/!important/i, "").trim().toLowerCase());
  }
  return declarations;
}

const zero = (value: string | undefined): boolean => value !== undefined && /^0+(\.0+)?(px|pt|em|rem|%)?$/.test(value);

/**
 * Preheaders are hidden with inline styles. Two look-alikes are not hiding:
 * `mso-hide:all` hides content from Outlook only, and `font-size:0` on a
 * layout container merely removes gaps between its children, which set their
 * own size. The latter is tracked as inherited text size instead.
 */
function hidden(element: Element, style: Map<string, string>): boolean {
  return attribute(element, "hidden") !== undefined || style.get("display") === "none" ||
    style.get("visibility") === "hidden" || zero(style.get("opacity")) || zero(style.get("max-height"));
}

function alignment(element: Element, style: Map<string, string>, inherited: Context["alignment"]): Context["alignment"] {
  // `align` on a table positions the table, not its text.
  const value = style.get("text-align") ?? (element.tagName === "table" ? undefined : attribute(element, "align")?.toLowerCase());
  if (element.tagName === "center" || value === "center") return "center";
  if (value === "right" || value === "end") return "right";
  if (value === "left" || value === "start" || value === "justify") return undefined;
  return inherited;
}

const PLAIN_BACKGROUND = /^(|none|transparent|inherit|initial|unset|white|#fff|#ffffff|rgba?\(\s*255\s*,\s*255\s*,\s*255\b.*)$/;
const filled = (value: string | undefined): boolean => value !== undefined && !PLAIN_BACKGROUND.test(value.trim().toLowerCase());

function meaningfulChildren(element: Element): Node[] {
  return element.childNodes.filter(child => !(child.nodeName === "#comment" ||
    child.nodeName === "#text" && !(child as DefaultTreeAdapterTypes.TextNode).value.trim()));
}

/** A link styled as a button, or the only content of a filled table cell. */
function buttonLike(anchor: Element, style: Map<string, string>, parent: Element | null): boolean {
  if (attribute(anchor, "role") === "button" || /(^|[\s_-])(btn|button)([\s_-]|$)/i.test(attribute(anchor, "class") ?? "")) return true;
  if (filled(style.get("background-color")) || filled(style.get("background")?.split(/\s+/)[0])) return true;
  if (!parent || parent.tagName !== "td" && parent.tagName !== "th") return false;
  const cell = inlineStyle(parent);
  return (filled(attribute(parent, "bgcolor")) || filled(cell.get("background-color")) || filled(cell.get("background")?.split(/\s+/)[0])) &&
    meaningfulChildren(parent).length === 1;
}

function dimension(element: Element, style: Map<string, string>, name: "width" | "height"): number | undefined {
  for (const raw of [attribute(element, name), style.get(name)]) {
    const match = raw?.trim().match(/^(\d{1,5})(?:\.\d+)?(px)?$/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function shape(context: Context): BlockShape {
  const result: BlockShape = { style: context.style };
  if (context.list && context.inItem) {
    result.listItem = context.list.type;
    result.level = Math.min(context.list.level, 3) as 1 | 2 | 3;
  }
  if (context.alignment) result.alignment = context.alignment;
  if (context.callToAction) result.callToAction = true;
  return result;
}

function image(element: Element, style: Map<string, string>, context: Context, builder: BlockBuilder): void {
  const source = (attribute(element, "src") ?? "").trim();
  const width = dimension(element, style, "width"), height = dimension(element, style, "height");
  if (width !== undefined && width <= 2 || height !== undefined && height <= 2) return builder.note("tracking-pixel-dropped");
  let reference: BridgeImageRef["source"];
  if (/^cid:/i.test(source)) {
    let contentId = source.slice(4);
    try { contentId = decodeURIComponent(contentId); } catch { /* keep the literal identifier */ }
    if (!contentId) return builder.note("image-dropped-invalid");
    reference = { kind: "inline", contentId };
  } else if (/^data:/i.test(source)) return builder.note("image-dropped-data-uri");
  else {
    const destination = httpsDestination(source);
    if ("rejected" in destination) {
      return builder.note(destination.rejected === "non-https" ? "image-dropped-non-https" : "image-dropped-invalid");
    }
    reference = { kind: "remote", url: destination.href };
  }
  const result: BridgeImageRef = {
    _type: "bridge.image", source: reference, alt: cleanProfileText(attribute(element, "alt") ?? "", 1024) || null,
  };
  if (width !== undefined) result.declaredWidth = width;
  if (height !== undefined) result.declaredHeight = height;
  if (context.href) result.link = context.href;
  builder.image(result);
}

function walk(node: Node, parent: Element | null, context: Context, builder: BlockBuilder): void {
  if (builder.truncated) return;
  if (node.nodeName === "#text") {
    if (context.zeroFont) {
      if ((node as DefaultTreeAdapterTypes.TextNode).value.trim()) builder.note("hidden-content-dropped");
      return;
    }
    builder.text((node as DefaultTreeAdapterTypes.TextNode).value, shape(context),
      { decorators: context.decorators, href: context.href, preserve: context.preserve });
    return;
  }
  if (!("tagName" in node)) return; // comments and doctypes
  const element = node, tag = element.tagName;
  if (SKIPPED.has(tag)) {
    if (tag !== "head" && tag !== "style" && tag !== "script" && tag !== "title" && tag !== "meta" && tag !== "link") {
      builder.note("unsupported-element-dropped");
    }
    return;
  }
  const style = inlineStyle(element);
  if (hidden(element, style)) return builder.note("hidden-content-dropped");
  if (context.depth >= context.maxDepth) return builder.note("nesting-too-deep");

  if (tag === "br") return builder.lineBreak();
  if (tag === "hr") { builder.flush(); return builder.note("rule-dropped"); }
  if (tag === "img") return image(element, style, context, builder);

  const next: Context = { ...context, depth: context.depth + 1, alignment: alignment(element, style, context.alignment) };
  const fontSize = style.get("font-size");
  if (fontSize !== undefined) next.zeroFont = zero(fontSize);
  const block = BLOCK.has(tag);
  if (block) builder.flush();

  if (tag in HEADING) next.style = HEADING[tag]!;
  else if (tag === "blockquote") next.style = "blockquote";
  else if (tag === "figcaption" || tag === "caption") next.style = "caption";
  else if (tag === "pre") next.preserve = true;
  else if (tag === "ul" || tag === "ol") {
    const level = (context.list?.level ?? 0) + 1;
    if (level > 3) builder.note("list-level-clamped");
    next.list = { type: tag === "ul" ? "bullet" : "number", level };
    next.inItem = false;
  } else if (tag === "li") next.inItem = true;
  else if (tag === "table" && element.childNodes.some(child => hasHeaderCell(child, 0))) {
    builder.note("data-table-flattened");
  }

  const decorators = new Set(context.decorators);
  const weight = style.get("font-weight");
  if (STRONG.has(tag) || weight === "bold" || weight === "bolder" || Number(weight) >= 600) decorators.add("strong");
  if (EMPHASIS.has(tag) || style.get("font-style") === "italic") decorators.add("em");
  if (CODE.has(tag) || tag === "pre") decorators.add("code");
  next.decorators = decorators;

  let button = false;
  if (tag === "a") {
    const raw = attribute(element, "href");
    if (raw !== undefined && !raw.trim().startsWith("#")) {
      const destination = httpsDestination(raw);
      if ("href" in destination) {
        next.href = destination.href;
        // A button becomes its own block; an inline link stays in its sentence.
        button = !builder.hasOpenText && buttonLike(element, style, parent);
        if (button) { builder.flush(); next.callToAction = true; }
      } else {
        builder.note(destination.rejected === "mailto" ? "link-dropped-mailto" :
          destination.rejected === "non-https" ? "link-dropped-non-https" : "link-dropped-invalid");
      }
    }
  }

  for (const child of element.childNodes) walk(child, element, next, builder);
  if (block || button) builder.flush();
}

function hasHeaderCell(node: Node, depth: number): boolean {
  if (!("tagName" in node) || depth > 3) return false;
  if (node.tagName === "th") return true;
  if (node.tagName === "table") return false;
  return node.childNodes.some(child => hasHeaderCell(child, depth + 1));
}

/** Converts an HTML email part into blocks. Never throws on malformed markup. */
export function convertHtml(html: string, builder: BlockBuilder, maxDepth: number): void {
  const document = parse(html);
  const root: Context = {
    style: "normal", list: null, inItem: false, alignment: undefined, decorators: new Set(), href: null,
    callToAction: false, preserve: false, zeroFont: false, depth: 0, maxDepth,
  };
  for (const child of document.childNodes) walk(child, null, root, builder);
  builder.flush();
}
