import PostalMime from "postal-mime";
import { cleanProfileText } from "./text.ts";
import { BridgeInputError, type EmailSource, type InlineImage } from "./types.ts";

export interface ParsedEmail {
  source: EmailSource;
  html?: string;
  text?: string;
  inlineImages: Map<string, InlineImage>;
  /** Parts that are neither a body alternative nor an inline image. */
  droppedAttachments: number;
}

const ADDRESS = /^[^\s@<>"]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

const contentIdKey = (value: string): string => value.trim().replace(/^<|>$/g, "");

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Parses a raw RFC 5322 message with bounded nesting, headers and part count. */
export async function parseEmail(raw: Uint8Array, maxMessageBytes: number): Promise<ParsedEmail> {
  if (raw.length === 0) throw new BridgeInputError("empty", "The message is empty");
  if (raw.length > maxMessageBytes) throw new BridgeInputError("message-too-large", "The message exceeds the accepted size");
  let email;
  try {
    email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer", maxNestingDepth: 16, maxHeadersSize: 256 * 1024, maxPartCount: 256,
      rfc822Attachments: true,
    });
  } catch { throw new BridgeInputError("unparseable", "The message could not be parsed"); }

  const address = email.from?.address?.trim().toLowerCase();
  if (!address || !ADDRESS.test(address)) throw new BridgeInputError("missing-sender", "The message has no usable From address");
  const source: EmailSource = { fromAddress: address };
  const name = cleanProfileText(email.from?.name ?? "", 256);
  if (name) source.fromName = name;
  const subject = cleanProfileText(email.subject ?? "", 512);
  if (subject) source.subject = subject;
  const listId = email.headers.find(header => header.key === "list-id")?.value.match(/<([^<>\s]{1,255})>\s*$/)?.[1];
  if (listId) source.listId = listId.toLowerCase();
  const messageId = email.messageId ? contentIdKey(email.messageId) : "";
  if (messageId && messageId.length <= 998) source.messageId = messageId;
  const date = email.date ? new Date(email.date) : null;
  if (date && !Number.isNaN(date.getTime())) source.date = date.toISOString();

  const inlineImages = new Map<string, InlineImage>();
  let droppedAttachments = 0;
  for (const attachment of email.attachments) {
    if (attachment.contentId && attachment.mimeType.toLowerCase().startsWith("image/")) {
      inlineImages.set(contentIdKey(attachment.contentId), { mediaType: attachment.mimeType.toLowerCase(), bytes: toBytes(attachment.content) });
    } else droppedAttachments++;
  }
  const parsed: ParsedEmail = { source, inlineImages, droppedAttachments };
  if (email.html?.trim()) parsed.html = email.html;
  if (email.text?.trim()) parsed.text = email.text;
  return parsed;
}
