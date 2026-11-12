import { readFileSync } from "node:fs";
import { validatePayload } from "@racrproto/codec";
import { describe, expect, it } from "vitest";
import {
  BridgeInputError, convertEmail, DEFAULT_LIMITS, TRUNCATION_NOTICE, type BridgeBlock, type BridgeImageRef,
  type BridgeTextBlock, type ConvertedEmail,
} from "../src/index.ts";

const fixture = (name: string): Uint8Array => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value.replace(/\r?\n/g, "\r\n"));
const htmlEmail = (html: string, headers = ""): Uint8Array => bytes(
  `From: Sender <news@sender.example>\nSubject: Test\n${headers}Content-Type: text/html; charset=utf-8\n\n${html}\n`);

const textBlocks = (blocks: BridgeBlock[]): BridgeTextBlock[] => blocks.filter(block => block._type === "block");
const images = (blocks: BridgeBlock[]): BridgeImageRef[] => blocks.filter(block => block._type === "bridge.image");
const plain = (block: BridgeBlock | undefined): string =>
  block?._type === "block" ? block.children.map(span => span.text).join("") : "";

/** Every emitted text block must already be a valid `spt-2` block. */
function expectValid(converted: ConvertedEmail): void {
  expect(() => validatePayload("hail.body.spt-2", { version: 1, profile: "spt-2", blocks: textBlocks(converted.blocks) })).not.toThrow();
}

describe("newsletter fixture", async () => {
  const converted = await convertEmail(fixture("newsletter.eml"));
  const text = textBlocks(converted.blocks);

  it("reads the sender, subject and list from decoded headers", () => {
    expect(converted.source).toEqual({
      fromAddress: "editors@fieldnotes.example", fromName: "The Field Notes ☕", subject: "Issue 12: Café culture",
      listId: "weekly.fieldnotes.example", messageId: "issue-12.abc@mail.fieldnotes.example", date: "2026-11-10T14:30:00.000Z",
    });
  });

  it("emits valid spt-2 text blocks", () => expectValid(converted));

  it("puts the subject first as the title and keeps the body heading", () => {
    expect(text[0]).toMatchObject({ style: "h1" });
    expect(plain(text[0])).toBe("Issue 12: Café culture");
    expect(text.map(block => block.style)).toContain("h2");
    expect(text.some(block => block.style === "h1" && plain(block) === "Café culture")).toBe(true);
  });

  it("keeps decorators and HTTPS links, joined across soft line breaks", () => {
    const welcome = text.find(block => plain(block).startsWith("Welcome back"))!;
    expect(plain(welcome)).toBe("Welcome back. This week we visit three very different cafés, and one roastery.");
    expect(welcome.children.find(span => span.text === "three")!.marks).toEqual(["strong"]);
    expect(welcome.children.find(span => span.text === "very")!.marks).toEqual(["em"]);
    expect(welcome.markDefs).toEqual([{ _key: "l1", _type: "spt.link", href: "https://fieldnotes.example/roastery?utm_source=nl" }]);
    expect(welcome.children.find(span => span.text === "roastery")!.marks).toEqual(["l1"]);
  });

  it("treats one break as a line and two as a paragraph", () => {
    expect(text.some(block => plain(block) === "First line\nsecond line")).toBe(true);
    expect(text.some(block => plain(block) === "New paragraph after two breaks.")).toBe(true);
  });

  it("maps nested lists and quotations", () => {
    expect(text.filter(block => block.listItem).map(block => [plain(block), block.listItem, block.level])).toEqual([
      ["Bright espresso", "bullet", 1], ["Quiet corners", "bullet", 1], ["Upstairs", "number", 2], ["By the window", "number", 2],
    ]);
    expect(text.find(block => block.style === "blockquote")).toBeDefined();
  });

  it("turns a filled table cell holding one link into a call to action", () => {
    expect(text.find(block => block.style === "cta")).toEqual({
      _type: "block", style: "cta", children: [{ _type: "span", text: "Read the full issue", marks: ["l1"] }],
      markDefs: [{ _key: "l1", _type: "spt.link", href: "https://fieldnotes.example/issue/12" }],
    });
  });

  it("keeps link text but drops http and mailto destinations", () => {
    const footer = text.find(block => plain(block).startsWith("You can"))!;
    expect(plain(footer)).toBe("You can visit the archive, write to us or unsubscribe.");
    expect(footer.alignment).toBe("center");
    expect(footer.markDefs.map(link => link.href)).toEqual(["https://fieldnotes.example/u/abc"]);
    expect(converted.diagnostics).toMatchObject({ "link-dropped-non-https": 1, "link-dropped-mailto": 1 });
  });

  it("references the linked logo and drops the tracking pixel", () => {
    expect(images(converted.blocks)).toEqual([{
      _type: "bridge.image", source: { kind: "remote", url: "https://cdn.fieldnotes.example/logo.png" }, alt: "Field Notes",
      declaredWidth: 200, declaredHeight: 60, link: "https://fieldnotes.example/",
    }]);
    expect(converted.diagnostics["tracking-pixel-dropped"]).toBe(1);
  });

  it("drops hidden, scripted and form content", () => {
    const everything = text.map(plain).join("\n");
    expect(everything).not.toMatch(/Preheader|alert|Ignored title|color: red/);
    expect(converted.diagnostics).toMatchObject({ "hidden-content-dropped": 1, "unsupported-element-dropped": 1, "rule-dropped": 1 });
  });
});

describe("HTML handling", () => {
  it("does not duplicate a body heading that repeats the subject", async () => {
    const converted = await convertEmail(htmlEmail("<h1> test </h1><p>Body</p>"));
    expect(textBlocks(converted.blocks).map(plain)).toEqual(["test", "Body"]);
  });

  it("keeps an inline link styled as a button inside its sentence", async () => {
    const converted = await convertEmail(htmlEmail('<p>Please <a class="btn" href="https://a.example/x">confirm</a> today.</p>'));
    const block = textBlocks(converted.blocks)[1]!;
    expect(block.style).toBe("normal");
    expect(plain(block)).toBe("Please confirm today.");
    expectValid(converted);
  });

  it("falls back to a normal link when a button label is too long for a call to action", async () => {
    const label = "word ".repeat(40).trim();
    const converted = await convertEmail(htmlEmail(`<div><a role="button" href="https://a.example/x"><b>${label}</b></a></div>`));
    const block = textBlocks(converted.blocks)[1]!;
    expect(block.style).toBe("normal");
    expect(block.children[0]!.marks).toEqual(["strong", "l1"]);
    expectValid(converted);
  });

  it("strips decorators from a call to action", async () => {
    const converted = await convertEmail(htmlEmail('<a style="background-color:#000" href="https://a.example/x"><b>Go</b> now</a>'));
    expect(textBlocks(converted.blocks)[1]).toMatchObject({ style: "cta", children: [{ text: "Go now", marks: ["l1"] }] });
    expectValid(converted);
  });

  it("keeps content inside zero-font layout containers and Outlook-only hiding", async () => {
    const converted = await convertEmail(htmlEmail(
      '<table><tr><td style="direction:ltr;font-size:0px;padding:20px 0">stray<div style="font-size:16px">Visible <b>text</b></div>' +
      '<img src="https://a.example/i.png" alt="Kept"></td></tr></table><div style="mso-hide:all">Shown outside Outlook</div>' +
      '<div style="font-size:0">gone <span>still gone</span></div>'));
    expect(textBlocks(converted.blocks).map(plain)).toEqual(["Test", "Visible text", "Shown outside Outlook"]);
    expect(images(converted.blocks)).toHaveLength(1);
    expect(converted.diagnostics["hidden-content-dropped"]).toBe(3);
  });

  it("clamps deep lists to three levels", async () => {
    const converted = await convertEmail(htmlEmail("<ul><li>1<ul><li>2<ul><li>3<ul><li>4</li></ul></li></ul></li></ul></li></ul>"));
    expect(textBlocks(converted.blocks).slice(1).map(block => block.level)).toEqual([1, 2, 3, 3]);
    expect(converted.diagnostics["list-level-clamped"]).toBe(1);
  });

  it("preserves preformatted text as code", async () => {
    const converted = await convertEmail(htmlEmail("<pre>a  b\n  c</pre>"));
    expect(textBlocks(converted.blocks)[1]!.children).toEqual([{ _type: "span", text: "a  b\n  c", marks: ["code"] }]);
  });

  it("resolves content-ID images to inline parts and reports unusable sources", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const raw = bytes([
      "From: a@b.example", "Subject: Inline", 'Content-Type: multipart/related; boundary="r"', "",
      "--r", "Content-Type: text/html; charset=utf-8", "",
      '<img src="cid:logo%40b.example" alt="  Logo​  "><img src="data:image/png;base64,AAAA"><img src="http://b.example/x.png">',
      "--r", "Content-Type: image/png", "Content-ID: <logo@b.example>", "Content-Transfer-Encoding: base64", "", png,
      "--r", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=a.pdf", "Content-Transfer-Encoding: base64", "", "AAAA",
      "--r--", "",
    ].join("\n"));
    const converted = await convertEmail(raw);
    expect(images(converted.blocks)).toEqual([{ _type: "bridge.image", source: { kind: "inline", contentId: "logo@b.example" }, alt: "Logo" }]);
    expect(converted.inlineImages.get("logo@b.example")).toMatchObject({ mediaType: "image/png" });
    expect(converted.inlineImages.get("logo@b.example")!.bytes.length).toBe(atob(png).length);
    expect(converted.diagnostics).toMatchObject({ "image-dropped-data-uri": 1, "image-dropped-non-https": 1, "attachment-dropped": 1 });
  });

  it("refuses credentialed, relative and oversized link destinations", async () => {
    const converted = await convertEmail(htmlEmail(
      `<p><a href="https://user:pw@a.example/">one</a> <a href="/relative">two</a> <a href="https://a.example/${"x".repeat(2100)}">three</a> <a href="#top">four</a> <a href="javascript:alert(1)">five</a></p>`));
    const block = textBlocks(converted.blocks)[1]!;
    expect(plain(block)).toBe("one two three four five");
    expect(block.markDefs).toEqual([]);
    expect(converted.diagnostics).toMatchObject({ "link-dropped-invalid": 3, "link-dropped-non-https": 1 });
  });

  it("removes control characters and repairs malformed text", async () => {
    const converted = await convertEmail(htmlEmail("<p>a\u0000b\u0007c é</p>"));
    expect(plain(textBlocks(converted.blocks)[1])).toBe("abc é");
    expectValid(converted);
  });

  it("stops converting below the nesting bound without overflowing the stack", async () => {
    const converted = await convertEmail(htmlEmail(`<p>kept</p>${"<div>".repeat(20_000)}deep${"</div>".repeat(20_000)}`));
    expect(textBlocks(converted.blocks).map(plain)).toEqual(["Test", "kept"]);
    expect(converted.diagnostics["nesting-too-deep"]).toBe(1);
  });
});

describe("plain text and fallbacks", () => {
  it("converts paragraphs and links HTTPS URLs", async () => {
    const converted = await convertEmail(bytes(
      "From: a@b.example\nSubject: Hello\nContent-Type: text/plain; charset=utf-8\n\nFirst line\nsecond line\n\nSee https://a.example/page. Or http://a.example/old\n"));
    const text = textBlocks(converted.blocks);
    expect(text.map(plain)).toEqual(["Hello", "First line\nsecond line", "See https://a.example/page. Or http://a.example/old"]);
    expect(text[2]!.markDefs).toEqual([{ _key: "l1", _type: "spt.link", href: "https://a.example/page" }]);
    expect(converted.diagnostics["html-missing"]).toBe(1);
    expectValid(converted);
  });

  it("uses the text part when the HTML part exceeds its bound or yields nothing", async () => {
    const alternative = (html: string) => bytes([
      "From: a@b.example", 'Content-Type: multipart/alternative; boundary="b"', "",
      "--b", "Content-Type: text/plain", "", "Readable text", "--b", "Content-Type: text/html", "", html, "--b--", "",
    ].join("\n"));
    const large = await convertEmail(alternative(`<p>${"x".repeat(5000)}</p>`), { ...DEFAULT_LIMITS, maxHtmlBytes: 1000 });
    expect(textBlocks(large.blocks).map(plain)).toEqual(["Readable text"]);
    expect(large.diagnostics["html-too-large"]).toBe(1);
    const empty = await convertEmail(alternative('<div style="display:none">hidden</div>'));
    expect(textBlocks(empty.blocks).map(plain)).toEqual(["Readable text"]);
  });

  it("rejects messages it cannot use", async () => {
    const code = (raw: Uint8Array, limits = DEFAULT_LIMITS) => convertEmail(raw, limits).then(() => "converted", error => (error as BridgeInputError).code);
    expect(await code(new Uint8Array())).toBe("empty");
    expect(await code(bytes("Subject: No sender\n\nBody\n"))).toBe("missing-sender");
    expect(await code(bytes("From: a@b.example\n\n\n"))).toBe("empty");
    expect(await code(htmlEmail("<p>x</p>"), { ...DEFAULT_LIMITS, maxMessageBytes: 10 })).toBe("message-too-large");
  });
});

describe("budgets", () => {
  const paragraphs = (count: number) => htmlEmail(Array.from({ length: count }, (_, index) => `<p>Paragraph ${index}</p>`).join(""));

  it("truncates at the block budget and ends with a visible notice", async () => {
    const converted = await convertEmail(paragraphs(100), { ...DEFAULT_LIMITS, maxBlocks: 10 });
    expect(converted.blocks.length).toBeLessThanOrEqual(11); // budget plus the subject title
    expect(plain(converted.blocks.at(-1))).toBe(TRUNCATION_NOTICE);
    expect(converted.diagnostics.truncated).toBe(1);
    expectValid(converted);
  });

  it("truncates at the item and text budgets", async () => {
    for (const limits of [{ maxItems: 200 }, { maxTextBytes: 300 }]) {
      const converted = await convertEmail(paragraphs(100), { ...DEFAULT_LIMITS, ...limits });
      expect(converted.blocks.length).toBeLessThan(40);
      expect(plain(converted.blocks.at(-1))).toBe(TRUNCATION_NOTICE);
    }
  });

  it("does not truncate a message inside the default budgets", async () => {
    const converted = await convertEmail(paragraphs(500));
    expect(converted.blocks.length).toBe(501);
    expect(converted.diagnostics.truncated).toBeUndefined();
    expectValid(converted);
  });

  it("splits a block that exceeds the span budget instead of dropping text", async () => {
    const html = `<p>${Array.from({ length: 30 }, (_, index) => index % 2 ? `<b>b${index}</b>` : `n${index}`).join(" ")}</p>`;
    const converted = await convertEmail(htmlEmail(html), { ...DEFAULT_LIMITS, maxSpansPerBlock: 8 });
    const text = textBlocks(converted.blocks).slice(1);
    expect(text.length).toBeGreaterThan(1);
    expect(text.every(block => block.children.length <= 8)).toBe(true);
    expect(text.map(plain).join(" ").match(/[bn]\d+/g)!.length).toBe(30);
  });
});
