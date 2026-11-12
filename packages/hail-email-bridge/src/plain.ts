import type { BlockBuilder, BlockShape } from "./builder.js";
import { httpsDestination } from "./text.js";

const NORMAL: BlockShape = { style: "normal" };
const NO_DECORATORS: ReadonlySet<never> = new Set();
const URL_PATTERN = /https:\/\/[^\s<>"']+/g;

/** Converts a text/plain part: blank lines separate paragraphs, HTTPS URLs become links. */
export function convertPlainText(text: string, builder: BlockBuilder): void {
  for (const paragraph of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/)) {
    if (builder.truncated) return;
    const lines = paragraph.split("\n").map(line => line.trimEnd()).filter(line => line);
    lines.forEach((line, index) => {
      let position = 0;
      const plain = (value: string) => builder.text(value, NORMAL, { decorators: NO_DECORATORS, href: null, preserve: true });
      for (const match of line.matchAll(URL_PATTERN)) {
        // Sentence punctuation after a URL is not part of it.
        const candidate = match[0].replace(/[.,;:!?)\]}>]+$/, "");
        const destination = httpsDestination(candidate);
        if ("rejected" in destination) continue;
        plain(line.slice(position, match.index));
        builder.text(candidate, NORMAL, { decorators: NO_DECORATORS, href: destination.href, preserve: true });
        position = match.index + candidate.length;
      }
      plain(line.slice(position));
      if (index < lines.length - 1) builder.lineBreak();
    });
    builder.flush();
  }
}
