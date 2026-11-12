import { BlockBuilder, plainBlock } from "./builder.js";
import { convertHtml } from "./html.js";
import { DEFAULT_LIMITS, utf8Length, type ConversionLimits } from "./limits.js";
import { parseEmail } from "./mime.js";
import { convertPlainText } from "./plain.js";
import { BridgeInputError, type BridgeBlock, type ConvertedEmail } from "./types.js";

const sameTitle = (left: string, right: string): boolean =>
  left.trim().toLowerCase().replace(/\s+/g, " ") === right.trim().toLowerCase().replace(/\s+/g, " ");

/** Clients show a leading `h1` as the message title, so the subject goes there. */
function withTitle(blocks: BridgeBlock[], subject: string | undefined): BridgeBlock[] {
  if (!subject) return blocks;
  const first = blocks[0];
  if (first?._type === "block" && first.style === "h1" && sameTitle(first.children.map(span => span.text).join(""), subject)) return blocks;
  return [plainBlock(subject, "h1"), ...blocks];
}

/**
 * Converts one raw email into text blocks and unresolved image references.
 * Performs no network or storage access. Lossy conversion is reported in
 * `diagnostics`; `BridgeInputError` means nothing usable could be produced.
 */
export async function convertEmail(raw: Uint8Array, limits: ConversionLimits = DEFAULT_LIMITS): Promise<ConvertedEmail> {
  const email = await parseEmail(raw, limits.maxMessageBytes);
  const builder = new BlockBuilder(limits);
  if (email.droppedAttachments) builder.note("attachment-dropped", email.droppedAttachments);

  let html = email.html;
  if (html !== undefined && utf8Length(html) > limits.maxHtmlBytes) { builder.note("html-too-large"); html = undefined; }
  if (html !== undefined) convertHtml(html, builder, limits.maxDepth);
  else {
    if (email.html === undefined) builder.note("html-missing");
    if (email.text !== undefined) convertPlainText(email.text, builder);
  }
  let blocks = builder.finish();
  // An HTML part that yields nothing readable still has a text alternative.
  if (!blocks.length && html !== undefined && email.text !== undefined) {
    const fallback = new BlockBuilder(limits);
    convertPlainText(email.text, fallback);
    blocks = fallback.finish();
    for (const [code, count] of Object.entries(fallback.diagnostics)) builder.note(code as keyof typeof fallback.diagnostics, count);
  }
  blocks = withTitle(blocks, email.source.subject);
  if (!blocks.length) throw new BridgeInputError("empty", "The message has no readable content");
  return { source: email.source, blocks, inlineImages: email.inlineImages, diagnostics: builder.diagnostics };
}
