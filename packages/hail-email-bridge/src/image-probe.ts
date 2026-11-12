export type ImageFormat = "png" | "jpeg" | "gif" | "webp";
export interface ImageProbe { format: ImageFormat; width: number; height: number; /** More than one frame. */ animated: boolean }

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

/**
 * Reads format, dimensions and animation from container headers only. It never
 * decodes pixels and is not structural validation: bundling still requires the
 * codec's validators. Returns null for anything unrecognized or truncated.
 */
export function probeImage(bytes: Uint8Array): ImageProbe | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (bytes.length >= 33 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") {
      let animated = false;
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const type = ascii(bytes, offset + 4, 4);
        if (type === "acTL") { animated = true; break; }
        if (type === "IDAT" || type === "IEND") break;
        offset += 12 + view.getUint32(offset);
      }
      return positive({ format: "png", width: view.getUint32(16), height: view.getUint32(20), animated });
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      for (let offset = 2; offset + 9 <= bytes.length;) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        if (marker === 0xff) { offset++; continue; }
        if (marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) { offset += 2; continue; }
        // Start-of-frame markers, excluding the Huffman, arithmetic and JPEG-extension tables.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return positive({ format: "jpeg", width: view.getUint16(offset + 7), height: view.getUint16(offset + 5), animated: false });
        }
        if (marker === 0xda || marker === 0xd9) return null;
        offset += 2 + view.getUint16(offset + 2);
      }
      return null;
    }
    if (bytes.length >= 13 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
      return positive({ format: "gif", width: view.getUint16(6, true), height: view.getUint16(8, true), animated: gifFrames(bytes) > 1 });
    }
    if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === "VP8X") {
        const uint24 = (offset: number) => bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
        return positive({ format: "webp", width: uint24(24) + 1, height: uint24(27) + 1, animated: (bytes[20]! & 0x02) !== 0 });
      }
      if (chunk === "VP8 ") {
        return positive({ format: "webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, animated: false });
      }
      if (chunk === "VP8L" && bytes[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        return positive({ format: "webp", width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1, animated: false });
      }
    }
  } catch { /* a truncated header reads out of range */ }
  return null;
}

const positive = (probe: ImageProbe): ImageProbe | null => probe.width > 0 && probe.height > 0 ? probe : null;

/** Counts image descriptors by walking GIF blocks; stops after the second frame. */
function gifFrames(bytes: Uint8Array): number {
  const flags = bytes[10]!;
  let offset = 13 + ((flags & 0x80) ? 3 * (1 << ((flags & 0x07) + 1)) : 0), frames = 0;
  const skipSubBlocks = () => { while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset]! + 1; offset++; };
  while (offset < bytes.length && frames < 2) {
    const introducer = bytes[offset++];
    if (introducer === 0x2c) {
      frames++;
      const local = bytes[offset + 8] ?? 0;
      offset += 9 + ((local & 0x80) ? 3 * (1 << ((local & 0x07) + 1)) : 0) + 1;
      skipSubBlocks();
    } else if (introducer === 0x21) { offset++; skipSubBlocks(); }
    else break;
  }
  return frames;
}
