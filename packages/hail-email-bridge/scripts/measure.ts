/**
 * Dry-run measurement for choosing body and image limits (plan decision D4).
 *
 *   bun scripts/measure.ts <directory of .eml files> [--fetch-images] [--json <file>]
 *
 * Nothing is stored or delivered. `--fetch-images` downloads every remote image
 * to measure it, which tells each sender that the message was opened; use it
 * only on mail you are content to have marked as read.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeDeterministic } from "@racrproto/codec/cbor";
import {
  blockItems, BridgeInputError, convertEmail, probeImage, UNBOUNDED_LIMITS, type BridgeImageRef, type Diagnostics, type ImageProbe,
} from "../src/index.ts";

const FETCH_BYTES = 8 * 1024 * 1024, FETCH_TIMEOUT = 15_000;
const UNBOUNDED_CBOR = {
  maximumBytes: Number.MAX_SAFE_INTEGER, maximumDepth: 32, maximumItems: Number.MAX_SAFE_INTEGER,
  maximumArrayLength: Number.MAX_SAFE_INTEGER, maximumMapEntries: 256, maximumTextBytes: Number.MAX_SAFE_INTEGER,
  maximumByteStringLength: Number.MAX_SAFE_INTEGER,
};

interface MeasuredImage { source: "remote" | "inline"; bytes?: number; probe?: ImageProbe | null; error?: string; hasAlt: boolean; linked: boolean }
interface Measurement {
  file: string; sender: string; textBlocks: number; images: MeasuredImage[]; items: number; textBodyBytes: number;
  diagnostics: Diagnostics;
}

async function fetchImage(url: string): Promise<{ bytes: Uint8Array } | { error: string }> {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { Accept: "image/*" } });
    if (!response.ok || !response.body) return { error: `status ${response.status}` };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > FETCH_BYTES) return { error: "larger than 8 MiB" };
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes };
  } catch (error) { return { error: error instanceof Error ? error.name : "fetch failed" }; }
}

async function measure(file: string, raw: Uint8Array, fetchImages: boolean): Promise<Measurement> {
  const converted = await convertEmail(raw, UNBOUNDED_LIMITS);
  const text = converted.blocks.filter(block => block._type === "block");
  const references = converted.blocks.filter((block): block is BridgeImageRef => block._type === "bridge.image");
  const images: MeasuredImage[] = [];
  for (const reference of references) {
    const image: MeasuredImage = { source: reference.source.kind, hasAlt: reference.alt !== null, linked: reference.link !== undefined };
    let bytes: Uint8Array | undefined;
    if (reference.source.kind === "inline") {
      bytes = converted.inlineImages.get(reference.source.contentId)?.bytes;
      if (!bytes) image.error = "missing inline part";
    } else if (fetchImages) {
      const fetched = await fetchImage(reference.source.url);
      if ("bytes" in fetched) bytes = fetched.bytes; else image.error = fetched.error;
    }
    if (bytes) { image.bytes = bytes.length; image.probe = probeImage(bytes); }
    images.push(image);
  }
  return {
    file, sender: converted.source.fromAddress.split("@")[1] ?? "", textBlocks: text.length, images,
    items: converted.blocks.reduce((sum, block) => sum + blockItems(block), 0),
    textBodyBytes: encodeDeterministic({ version: 1, profile: "spt-2", blocks: text }, UNBOUNDED_CBOR).length,
    diagnostics: converted.diagnostics,
  };
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

function row(label: string, values: number[]): string {
  const cells = [0.5, 0.9, 0.95, 1].map(fraction => String(percentile(values, fraction)).padStart(10));
  return `${label.padEnd(34)}${cells.join("")}`;
}

function report(measurements: Measurement[], failures: Record<string, number>, fetched: boolean): string {
  const lines: string[] = [];
  const measured = (image: MeasuredImage) => image.bytes !== undefined;
  const all = measurements.flatMap(entry => entry.images);
  lines.push(`Messages converted: ${measurements.length}`);
  for (const [code, count] of Object.entries(failures)) lines.push(`Not convertible (${code}): ${count}`);
  lines.push("", `${"Per message".padEnd(34)}${["p50", "p90", "p95", "max"].map(name => name.padStart(10)).join("")}`);
  lines.push(row("Text blocks", measurements.map(entry => entry.textBlocks)));
  lines.push(row("Image references", measurements.map(entry => entry.images.length)));
  lines.push(row("CBOR items (limit 16384)", measurements.map(entry => entry.items)));
  lines.push(row("Text-only body bytes", measurements.map(entry => entry.textBodyBytes)));
  if (all.some(measured)) {
    const sum = (entry: Measurement, value: (image: MeasuredImage) => number) => entry.images.reduce((total, image) => total + value(image), 0);
    lines.push(row("Image bytes, total", measurements.map(entry => sum(entry, image => image.bytes ?? 0))));
    lines.push(row("Image pixels, total", measurements.map(entry => sum(entry, image => (image.probe?.width ?? 0) * (image.probe?.height ?? 0)))));
    lines.push(row("Body bytes with images", measurements.map(entry => entry.textBodyBytes + sum(entry, image => image.bytes ?? 0))));
    const sized = all.filter(measured);
    lines.push("", `${"Per measured image".padEnd(34)}${["p50", "p90", "p95", "max"].map(name => name.padStart(10)).join("")}`);
    lines.push(row("Bytes", sized.map(image => image.bytes!)));
    lines.push(row("Width", sized.map(image => image.probe?.width ?? 0)));
    lines.push(row("Height", sized.map(image => image.probe?.height ?? 0)));
    const formats: Record<string, number> = {};
    for (const image of sized) {
      const name = image.probe ? `${image.probe.format}${image.probe.animated ? " (animated)" : ""}` : "unrecognized";
      formats[name] = (formats[name] ?? 0) + 1;
    }
    lines.push("", "Image formats: " + Object.entries(formats).map(([name, count]) => `${name} ${count}`).join(", "));
  }
  const failed = all.filter(image => image.error).length;
  lines.push(`Images: ${all.length} referenced, ${all.filter(measured).length} measured, ${failed} unavailable` +
    (fetched ? "" : " (remote images not fetched; pass --fetch-images to measure them)"));
  lines.push(`Images without alternative text: ${all.filter(image => !image.hasAlt).length}; inside a link: ${all.filter(image => image.linked).length}`);
  const diagnostics: Record<string, { messages: number; total: number }> = {};
  for (const entry of measurements) {
    for (const [code, count] of Object.entries(entry.diagnostics)) {
      const tally = diagnostics[code] ??= { messages: 0, total: 0 };
      tally.messages++; tally.total += count;
    }
  }
  lines.push("", "Diagnostics (messages affected / occurrences):");
  for (const [code, tally] of Object.entries(diagnostics).sort()) lines.push(`  ${code.padEnd(32)}${tally.messages} / ${tally.total}`);
  return lines.join("\n");
}

const args = process.argv.slice(2);
const directory = args.find(argument => !argument.startsWith("--") && args[args.indexOf(argument) - 1] !== "--json");
const fetchImages = args.includes("--fetch-images");
const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
if (!directory) {
  console.error("Usage: bun scripts/measure.ts <directory of .eml files> [--fetch-images] [--json <file>]");
  process.exit(2);
}
const files = readdirSync(directory).filter(name => name.toLowerCase().endsWith(".eml")).sort();
const measurements: Measurement[] = [], failures: Record<string, number> = {};
for (const file of files) {
  try { measurements.push(await measure(file, readFileSync(join(directory, file)), fetchImages)); }
  catch (error) {
    if (!(error instanceof BridgeInputError)) throw error;
    failures[error.code] = (failures[error.code] ?? 0) + 1;
  }
}
console.log(report(measurements, failures, fetchImages));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(measurements, null, 2));
