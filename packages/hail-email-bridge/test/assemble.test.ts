import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { decodePayload, type HailSpt2Body, type HailSpt3Body } from "@racrproto/codec";
import { describe, expect, it } from "vitest";
import {
  assembleBody, BridgeInputError, convertEmail, CURRENT_IMAGE_POLICY, type AssembleOptions, type ImagePolicy,
} from "../src/index.js";

/** A complete, structurally valid RGBA PNG of the requested size. */
function png(width: number, height: number, padding = 0): Uint8Array {
  const chunk = (name: string, data: Uint8Array) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    // An ancillary text chunk makes a file of a chosen size without changing its pixels.
    ...(padding ? [chunk("tEXt", Buffer.alloc(padding, 0x61))] : []),
    chunk("IDAT", deflateSync(new Uint8Array((width * 4 + 1) * height))), chunk("IEND", new Uint8Array()),
  ]));
}
/** The frozen JPEG from the shared attachment vectors. */
const JPEG = Uint8Array.from(Buffer.from((JSON.parse(readFileSync(new URL("../../../spec/vectors/attachment-images.json", import.meta.url), "utf8")) as
  { records: { id: string; fileHex: string }[] }).records.find(record => record.id === "baseline.jpg")!.fileHex, "hex"));
const GIF = Uint8Array.from(atob("R0lGODlhEAAQAIAAAAAAAP///yH5BAEAAAAALAAAAAAQABAAAAIBRAA7"), character => character.charCodeAt(0));

const email = (html: string, from = "Field Notes <editors@fieldnotes.example>") => new TextEncoder().encode(
  `From: ${from}\r\nSubject: Issue\r\nList-Id: <weekly.fieldnotes.example>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`);

function options(images: Record<string, Uint8Array | null | Error>, policy?: Partial<ImagePolicy>): AssembleOptions & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested, authentication: "dkim-aligned", receivedAt: 1_700_000_000, policy: { ...CURRENT_IMAGE_POLICY, ...policy },
    resolveRemote: async url => {
      requested.push(url);
      const result = images[url] ?? null;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
const assemble = async (html: string, images: Record<string, Uint8Array | null | Error> = {}, policy?: Partial<ImagePolicy>) => {
  const settings = options(images, policy);
  return { ...await assembleBody(await convertEmail(email(html)), settings), requested: settings.requested };
};
const texts = (body: HailSpt2Body | HailSpt3Body): string[] =>
  body.blocks.map(block => block._type === "block" ? block.children.map(span => span.text).join("") : `[${block.asset}: ${block.alt}]`);

describe("assembleBody", () => {
  it("produces a text body with the origin statement when there are no images", async () => {
    const { body, bytes } = await assemble("<p>Hello</p>");
    expect(body).toMatchObject({ profile: "spt-2", origin: {
      type: "email", from_address: "editors@fieldnotes.example", from_name: "Field Notes", list_id: "weekly.fieldnotes.example",
      authentication: "dkim-aligned", received_at: 1_700_000_000,
    } });
    expect(decodePayload("hail.body.spt-2", bytes)).toEqual(body);
  });

  it("bundles an admitted image and follows a linked one with its destination", async () => {
    const logo = png(200, 60);
    const { body, bytes, requested } = await assemble(
      '<p>Intro</p><a href="https://fieldnotes.example/"><img src="https://cdn.example/logo.png" alt="Field Notes"></a><p>Outro</p>',
      { "https://cdn.example/logo.png": logo });
    expect(requested).toEqual(["https://cdn.example/logo.png"]);
    expect(texts(body)).toEqual(["Issue", "Intro", "[image-1: Field Notes]", "Field Notes", "Outro"]);
    const spt3 = decodePayload("hail.body.spt-3", bytes);
    expect(spt3.assets.assets).toHaveLength(1);
    expect(spt3.assets.assets[0]).toMatchObject({ id: "image-1", role: "image", media_type: "image/png", width: 200, height: 60, size: logo.length });
    expect(spt3.blocks[3]).toMatchObject({ style: "caption", markDefs: [{ href: "https://fieldnotes.example/" }] });
  });

  it("bundles a JPEG under its own media type and links one whose bytes are damaged", async () => {
    const damaged = JPEG.slice(0, JPEG.length - 2);
    const { body, diagnostics } = await assemble('<img src="https://cdn.example/p.jpg" alt="Photo"><img src="https://cdn.example/d.jpg" alt="Damaged">',
      { "https://cdn.example/p.jpg": JPEG, "https://cdn.example/d.jpg": damaged }, { minDimension: 1 });
    expect(texts(body)).toEqual(["Issue", "[image-1: Photo]", "Image: Damaged"]);
    expect((body as HailSpt3Body).assets.assets[0]).toMatchObject({ media_type: "image/jpeg", size: JPEG.length });
    expect(diagnostics["image-linked-unsupported"]).toBe(1);
  });

  it("supplies a stated placeholder when an image has no description", async () => {
    const { body } = await assemble('<img src="https://cdn.example/a.png">', { "https://cdn.example/a.png": png(10, 10) });
    expect(texts(body)).toEqual(["Issue", "[image-1: Image without a description]"]);
  });

  it("fetches a repeated image once and counts each appearance", async () => {
    const { body, requested } = await assemble('<img src="https://cdn.example/a.png" alt="A"><p>x</p><img src="https://cdn.example/a.png" alt="A again">',
      { "https://cdn.example/a.png": png(10, 10) });
    expect(requested).toHaveLength(1);
    expect((body as HailSpt3Body).assets.assets).toHaveLength(1);
    expect(texts(body)).toEqual(["Issue", "[image-1: A]", "x", "[image-1: A again]"]);
  });

  it("links images that are unsupported, oversized, unavailable or malformed", async () => {
    const truncated = png(10, 10).subarray(0, 40);
    const { body, diagnostics } = await assemble(
      ["gif", "big", "wide", "gone", "boom", "bad"].map(name => `<img src="https://cdn.example/${name}" alt="${name}">`).join(""), {
        "https://cdn.example/gif": GIF, "https://cdn.example/big": png(10, 10, 530_000), "https://cdn.example/wide": png(2401, 3),
        "https://cdn.example/gone": null, "https://cdn.example/boom": new Error("network"), "https://cdn.example/bad": truncated,
      });
    expect(body.profile).toBe("spt-2");
    expect(texts(body)).toEqual(["Issue", ...["gif", "big", "wide", "gone", "boom", "bad"].map(name => `Image: ${name}`)]);
    expect(body.blocks[1]).toMatchObject({ markDefs: [{ href: "https://cdn.example/gif" }] });
    expect(diagnostics).toMatchObject({ "image-linked-unsupported": 2, "image-linked-too-large": 2, "image-unavailable": 2 });
  });

  it("drops images that turn out to be trackers and keeps undescribed unavailable ones as links", async () => {
    const { body, diagnostics } = await assemble('<p>x</p><img src="https://t.example/open"><img src="https://cdn.example/gone">',
      { "https://t.example/open": png(1, 1) });
    expect(texts(body)).toEqual(["Issue", "x", "Image: Image"]);
    expect(diagnostics["tracking-pixel-dropped"]).toBe(1);
  });

  it("enforces the image count, pixel and body budgets", async () => {
    const many = Array.from({ length: 4 }, (_, index) => `<img src="https://cdn.example/${index}" alt="i${index}">`).join("");
    const images = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`https://cdn.example/${index}`, png(100, 100, index)]));
    const count = await assemble(many, images, { maxImages: 2 });
    expect(texts(count.body)).toEqual(["Issue", "[image-1: i0]", "[image-2: i1]", "Image: i2", "Image: i3"]);
    expect((count.body as HailSpt3Body).assets.assets).toHaveLength(2);
    const pixels = await assemble(many, images, { maxTotalPixels: 25_000 });
    expect(texts(pixels.body).filter(text => text.startsWith("["))).toHaveLength(2);
    expect((pixels.body as HailSpt3Body).assets.assets).toHaveLength(2);
    const bytes = await assemble(many, images, { maxBodyBytes: 3200 });
    expect(bytes.bytes.length).toBeLessThanOrEqual(3200);
    expect(bytes.diagnostics["image-linked-budget"]).toBeGreaterThan(0);
  });

  it("stops requesting remote images at the fetch budget", async () => {
    const html = Array.from({ length: 5 }, (_, index) => `<img src="https://cdn.example/${index}" alt="i${index}">`).join("");
    const { requested, diagnostics } = await assemble(html, {}, { maxFetches: 2 });
    expect(requested).toHaveLength(2);
    expect(diagnostics).toMatchObject({ "image-unavailable": 2, "image-linked-budget": 3 });
  });

  it("uses inline parts without fetching and notes a missing part", async () => {
    const image = png(20, 20);
    const raw = new TextEncoder().encode([
      "From: a@b.example", 'Content-Type: multipart/related; boundary="r"', "",
      "--r", "Content-Type: text/html", "", '<img src="cid:one" alt="One"><img src="cid:missing" alt="Lost">',
      "--r", "Content-Type: image/png", "Content-ID: <one>", "Content-Transfer-Encoding: base64", "", Buffer.from(image).toString("base64"),
      "--r--", "",
    ].join("\r\n"));
    const settings = options({});
    const { body, diagnostics } = await assembleBody(await convertEmail(raw), settings);
    expect(settings.requested).toEqual([]);
    expect(texts(body)).toEqual(["[image-1: One]", "Image: Lost"]);
    expect(diagnostics["image-unavailable"]).toBe(1);
  });

  it("omits an unusable list identifier and refuses a sender address outside the origin syntax", async () => {
    const converted = await convertEmail(email("<p>x</p>"));
    converted.source.listId = "Weekly List";
    expect((await assembleBody(converted, options({}))).body.origin).not.toHaveProperty("list_id");
    const odd = await convertEmail(email("<p>x</p>", "josé@fieldnotes.example"));
    await expect(assembleBody(odd, options({}))).rejects.toBeInstanceOf(BridgeInputError);
  });
});
