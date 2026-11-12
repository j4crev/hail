import { describe, expect, it } from "vitest";
import { probeImage } from "../src/index.js";

const base64 = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));
const hex = (value: string): Uint8Array => Uint8Array.from(value.replace(/\s+/g, "").match(/../g)!, byte => parseInt(byte, 16));

const PNG = base64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
const GIF = base64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

/** Header-only samples: enough structure for the probe, not decodable images. */
const JPEG = hex("ffd8 ffe0 0010 4a46494600010100000100010000 ffdb 0004 0000 ffc0 0011 08 0030 0040 03 012200 021101 031101 ffda");
const WEBP_LOSSY = hex("52494646 1e000000 57454250 56503820 12000000 000000 9d012a 4000 3000 0000000000000000");
const WEBP_EXTENDED = hex("52494646 16000000 57454250 56503858 0a000000 02000000 3f0000 2f0000");

function animatedGif(): Uint8Array {
  const frame = GIF.subarray(13 + 6, GIF.length - 1); // graphic control extension and image, without header or trailer
  return Uint8Array.from([...GIF.subarray(0, 19), ...frame, ...frame, 0x3b]);
}

describe("probeImage", () => {
  it("reads PNG dimensions", () => expect(probeImage(PNG)).toEqual({ format: "png", width: 1, height: 1, animated: false }));
  it("reads JPEG dimensions from the frame header", () =>
    expect(probeImage(JPEG)).toEqual({ format: "jpeg", width: 64, height: 48, animated: false }));
  it("reads a static GIF", () => expect(probeImage(GIF)).toEqual({ format: "gif", width: 1, height: 1, animated: false }));
  it("detects a second GIF frame", () => expect(probeImage(animatedGif())).toMatchObject({ format: "gif", animated: true }));
  it("reads lossy WebP dimensions", () =>
    expect(probeImage(WEBP_LOSSY)).toEqual({ format: "webp", width: 64, height: 48, animated: false }));
  it("reads the extended WebP canvas and animation flag", () =>
    expect(probeImage(WEBP_EXTENDED)).toEqual({ format: "webp", width: 64, height: 48, animated: true }));

  it("returns null for unknown, empty and truncated input", () => {
    expect(probeImage(new Uint8Array())).toBeNull();
    expect(probeImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    for (const sample of [PNG, JPEG, GIF, WEBP_LOSSY, WEBP_EXTENDED]) {
      // Thirteen bytes is the shortest header any format can be read from.
      for (let length = 0; length < 13; length++) expect(probeImage(sample.subarray(0, length))).toBeNull();
    }
  });
});
