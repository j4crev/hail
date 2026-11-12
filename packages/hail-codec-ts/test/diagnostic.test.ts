import { describe, expect, it } from "vitest";

import {
  encodeBase64Url,
  fromDiagnosticJson,
  toDiagnosticJson,
} from "../src/index.js";
import { createHash } from "node:crypto";
import { encodePayload, type HailSpt3Body } from "../src/index.js";
import { envelope, inlineImageBody } from "./fixtures.js";

describe("diagnostic JSON", () => {
  it("round trips schema-known byte fields", () => {
    const diagnostic = toDiagnosticJson("hail.envelope", envelope, false);
    expect(fromDiagnosticJson("hail.envelope", diagnostic)).toEqual(envelope);
  });

  it("redacts bearer tokens by default", () => {
    const diagnostic = toDiagnosticJson("hail.envelope", envelope) as Record<
      string,
      unknown
    >;
    const body = diagnostic.body as Record<string, unknown>;
    const access = body.access as Record<string, unknown>;
    expect(access.token).toBe("[REDACTED]");
  });

  it("uses unpadded base64url", () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("accepts a full-size image body, whose base64 text is larger than its bytes", () => {
    // Two images near the 512 KiB limit: about 1 MiB of bytes, about 1.4 million JSON characters.
    const padded = (size: number) => {
      const data = new Uint8Array(size - pngFile.length - 12).fill(0x61), chunk = Buffer.alloc(data.length + 12);
      chunk.writeUInt32BE(data.length); chunk.write("tEXt", 4, "latin1"); chunk.set(data, 8);
      let crc = 0xffffffff;
      for (const byte of chunk.subarray(4, 8 + data.length)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
      return new Uint8Array(Buffer.concat([pngFile.subarray(0, 33), chunk, pngFile.subarray(33)]));
    };
    const pngFile = inlineImageBody.assets.assets[0].data;
    const asset = (id: string, size: number) => {
      const data = padded(size);
      return { ...inlineImageBody.assets.assets[0], id, size, data, digest: { algorithm: "sha-256" as const, value: new Uint8Array(createHash("sha256").update(data).digest()) } };
    };
    const body: HailSpt3Body = { version: 1, profile: "spt-3", assets: { version: 1, assets: [asset("image-a", 524_288), asset("image-b", 500_000)] },
      blocks: [{ _type: "spt.image", asset: "image-a", alt: "First" }, { _type: "spt.image", asset: "image-b", alt: "Second" }] };
    const bytes = encodePayload("hail.body.spt-3", body);
    expect(bytes.length).toBeGreaterThan(1_000_000);
    const diagnostic = toDiagnosticJson("hail.body.spt-3", body);
    expect(JSON.stringify(diagnostic).length).toBeGreaterThan(1_300_000);
    expect(fromDiagnosticJson("hail.body.spt-3", diagnostic)).toEqual(body);
    // The real limits still apply after conversion: three such images exceed the 1 MiB body.
    const over = { ...body, assets: { version: 1 as const, assets: [...body.assets.assets, asset("image-c", 300_000)] as HailSpt3Body["assets"]["assets"] },
      blocks: [...body.blocks, { _type: "spt.image" as const, asset: "image-c", alt: "Third" }] };
    expect(() => fromDiagnosticJson("hail.body.spt-3", toDiagnosticJson("hail.body.spt-3", over))).toThrow();
  });

  it("rejects values outside the Hail data model before conversion", () => {
    const invalid = { ...envelope, reply_to: undefined } as unknown;
    expect(() =>
      fromDiagnosticJson("hail.envelope", invalid as never),
    ).toThrow(/\$\.reply_to: unsupported Hail value/);

    let deeplyNested: unknown = null;
    for (let depth = 0; depth < 33; depth += 1) deeplyNested = [deeplyNested];
    expect(() =>
      fromDiagnosticJson("hail.envelope", deeplyNested as never),
    ).toThrow(/nesting depth/);
  });
});
