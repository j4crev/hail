import { utf8Length } from "./limits.js";

const CONTROL_EXCEPT_NEWLINE = /[\p{Cc}]/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** Unpaired surrogates are rejected by the codec; replace them as a decoder would. */
function wellFormed(value: string): string {
  return value.toWellFormed();
}

/** Span text: NFC, no control characters except line feed. */
export function cleanSpanText(value: string): string {
  return wellFormed(value).replace(/\r\n?/g, "\n").replace(CONTROL_EXCEPT_NEWLINE, character => character === "\n" ? "\n" : "")
    .normalize("NFC");
}

/** Cuts at a code point boundary so the result is at most `maximum` UTF-8 bytes. */
export function truncateUtf8(value: string, maximum: number): string {
  if (utf8Length(value) <= maximum) return value;
  let size = 0, output = "";
  for (const character of value) {
    size += utf8Length(character);
    if (size > maximum) break;
    output += character;
  }
  return output;
}

/**
 * One line of NFC plain text without control or format characters, as the body
 * profile requires for image alternatives and captions. Returns "" when nothing
 * remains.
 */
export function cleanProfileText(value: string, maximumBytes: number): string {
  const cleaned = wellFormed(value).replace(/[\s ]+/g, " ").replace(CONTROL_OR_FORMAT, "").normalize("NFC").trim();
  return truncateUtf8(cleaned, maximumBytes).trim();
}

export type LinkRejection = "non-https" | "mailto" | "invalid";

/**
 * Applies the body link rules: absolute HTTPS, no credentials, bounded length.
 * Returns the normalized destination or the reason it was refused.
 */
export function httpsDestination(raw: string): { href: string } | { rejected: LinkRejection } {
  let candidate = raw.trim();
  if (!candidate) return { rejected: "invalid" };
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (/^mailto:/i.test(candidate)) return { rejected: "mailto" };
  let url: URL;
  try { url = new URL(candidate); } catch { return { rejected: "invalid" }; }
  if (url.protocol !== "https:") return { rejected: /^[a-z][a-z0-9+.-]*:/i.test(candidate) ? "non-https" : "invalid" };
  if (url.username || url.password || !url.hostname) return { rejected: "invalid" };
  const href = url.href;
  if (!href.startsWith("https://") || utf8Length(href) > 2048) return { rejected: "invalid" };
  return { href };
}
