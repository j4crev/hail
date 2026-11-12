import {
  BUNDLED_IMAGE_LIMITS, encodePayload, validateJpegStructure, validatePngStructure, type HailBodyOriginEmail, type HailBundledImageAsset, type HailSpt2Body,
  type HailSpt2TextBlock, type HailSpt3Body, type HailSptImageBlock,
} from "@racrproto/codec";
import { encodeDeterministic } from "@racrproto/codec/cbor";
import { probeImage, type ImageFormat } from "./image-probe.js";
import { cleanProfileText } from "./text.js";
import { BridgeInputError, type BridgeImageRef, type BridgeTextBlock, type ConvertedEmail, type DiagnosticCode, type Diagnostics } from "./types.js";

/** Which referenced images may be bundled. Everything else becomes a link. */
export interface ImagePolicy {
  formats: ReadonlySet<ImageFormat>;
  maxImages: number;
  maxImageBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxImagePixels: number;
  maxTotalPixels: number;
  /** Complete encoded body, including text and every bundled image. */
  maxBodyBytes: number;
  /** Images narrower or shorter than this are trackers or spacers and are dropped. */
  minDimension: number;
  /** Remote images requested for one message. */
  maxFetches: number;
}

/** The current `spt-3` rules, taken from the codec so the two cannot drift. */
export const CURRENT_IMAGE_POLICY: ImagePolicy = {
  formats: new Set<ImageFormat>(["png", "jpeg"]), maxImages: BUNDLED_IMAGE_LIMITS.maximumImageBlocks,
  maxImageBytes: BUNDLED_IMAGE_LIMITS.message.bytes, maxWidth: BUNDLED_IMAGE_LIMITS.message.width,
  maxHeight: BUNDLED_IMAGE_LIMITS.message.height, maxImagePixels: BUNDLED_IMAGE_LIMITS.message.pixels,
  maxTotalPixels: BUNDLED_IMAGE_LIMITS.maximumBodyPixels, maxBodyBytes: 1_048_576, minDimension: 3, maxFetches: 48,
};

/**
 * Returns the bytes of a remote image, or null when it is unavailable. The
 * caller owns safe fetching: HTTPS only, no private addresses, bounded size,
 * time and redirects. `maxBytes` is the largest response worth returning.
 */
export type RemoteImageResolver = (url: string, maxBytes: number) => Promise<Uint8Array | null>;

export interface AssembleOptions {
  /** What the receiving side established about the message. */
  authentication: HailBodyOriginEmail["authentication"];
  receivedAt: number;
  resolveRemote: RemoteImageResolver;
  policy?: ImagePolicy;
}

export interface AssembledBody {
  body: HailSpt2Body | HailSpt3Body;
  /** Deterministic body bytes, already validated by the codec. */
  bytes: Uint8Array;
  diagnostics: Diagnostics;
}

const NO_DESCRIPTION = "Image without a description";
/** Room for the body wrapper, origin and per-asset metadata around the measured parts. */
const WRAPPER_BYTES = 2048, ASSET_OVERHEAD_BYTES = 192;
const UNBOUNDED = {
  maximumBytes: Number.MAX_SAFE_INTEGER, maximumDepth: 32, maximumItems: Number.MAX_SAFE_INTEGER,
  maximumArrayLength: Number.MAX_SAFE_INTEGER, maximumMapEntries: 256, maximumTextBytes: Number.MAX_SAFE_INTEGER,
  maximumByteStringLength: Number.MAX_SAFE_INTEGER,
};

type Refusal = Extract<DiagnosticCode, `image-${string}` | "tracking-pixel-dropped">;
interface Candidate { bytes: Uint8Array; width: number; height: number; mediaType: "image/png" | "image/jpeg" }

const linkBlock = (text: string, href: string, style: "normal" | "caption"): HailSpt2TextBlock => ({
  _type: "block", style, children: [{ _type: "span", text, marks: ["l1"] }], markDefs: [{ _key: "l1", _type: "spt.link", href }],
});

function origin(converted: ConvertedEmail, options: AssembleOptions): HailBodyOriginEmail {
  const { source } = converted;
  const result: HailBodyOriginEmail = {
    type: "email", from_address: source.fromAddress, authentication: options.authentication, received_at: options.receivedAt,
  };
  const name = cleanProfileText(source.fromName ?? "", 256);
  if (name) result.from_name = name;
  if (source.listId && /^[a-z0-9](?:[a-z0-9._-]{0,253}[a-z0-9])?$/.test(source.listId)) result.list_id = source.listId;
  return result;
}

/** Applies the per-image rules. Structural validation is the codec's, not the probe's. */
function inspect(bytes: Uint8Array, policy: ImagePolicy): Candidate | Refusal {
  const probe = probeImage(bytes);
  if (!probe) return "image-linked-unsupported";
  if (probe.width < policy.minDimension || probe.height < policy.minDimension) return "tracking-pixel-dropped";
  if (!policy.formats.has(probe.format) || probe.animated) return "image-linked-unsupported";
  if (bytes.length > policy.maxImageBytes || probe.width > policy.maxWidth || probe.height > policy.maxHeight ||
    probe.width * probe.height > policy.maxImagePixels) return "image-linked-too-large";
  // The codec has validators for exactly the formats the profile admits.
  if (probe.format !== "png" && probe.format !== "jpeg") return "image-linked-unsupported";
  try {
    // The validator's dimensions are authoritative; the probe only pre-screens.
    const { width, height } = probe.format === "png" ? validatePngStructure(bytes) : validateJpegStructure(bytes);
    if (width > policy.maxWidth || height > policy.maxHeight || width * height > policy.maxImagePixels) return "image-linked-too-large";
    return { bytes, width, height, mediaType: probe.format === "png" ? "image/png" : "image/jpeg" };
  } catch { return "image-linked-unsupported"; }
}

/**
 * Turns converted blocks into a signed-ready body: fetches and bundles the
 * images the policy admits, links the rest, and attaches the origin statement.
 */
export async function assembleBody(converted: ConvertedEmail, options: AssembleOptions): Promise<AssembledBody> {
  const policy = options.policy ?? CURRENT_IMAGE_POLICY;
  const diagnostics: Diagnostics = { ...converted.diagnostics };
  const note = (code: DiagnosticCode) => { diagnostics[code] = (diagnostics[code] ?? 0) + 1; };

  const text = converted.blocks.filter((block): block is BridgeTextBlock => block._type === "block");
  const textBytes = encodeDeterministic({ version: 1, profile: "spt-2", blocks: text }, UNBOUNDED).length;
  let remaining = policy.maxBodyBytes - textBytes - WRAPPER_BYTES;

  const assets: HailBundledImageAsset[] = [];
  const bySource = new Map<string, { id: string; width: number; height: number } | Refusal>();
  const blocks: (HailSptImageBlock | HailSpt2TextBlock)[] = [];
  let images = 0, pixels = 0, fetches = 0;

  const resolve = async (reference: BridgeImageRef): Promise<{ id: string; width: number; height: number } | Refusal> => {
    const key = reference.source.kind === "inline" ? `cid:${reference.source.contentId}` : reference.source.url;
    const known = bySource.get(key);
    if (known) return known;
    let bytes: Uint8Array | null | undefined;
    if (reference.source.kind === "inline") bytes = converted.inlineImages.get(reference.source.contentId)?.bytes;
    else if (fetches++ < policy.maxFetches) {
      try { bytes = await options.resolveRemote(reference.source.url, Math.min(policy.maxImageBytes, Math.max(remaining, 0))); }
      catch { bytes = null; }
    } else { bySource.set(key, "image-linked-budget"); return "image-linked-budget"; }
    let outcome: { id: string; width: number; height: number } | Refusal;
    if (!bytes) outcome = "image-unavailable";
    else {
      const candidate = inspect(bytes, policy);
      if (typeof candidate === "string") outcome = candidate;
      else if (candidate.bytes.length + ASSET_OVERHEAD_BYTES > remaining || assets.length >= policy.maxImages) outcome = "image-linked-budget";
      else {
        const id = `image-${assets.length + 1}`;
        assets.push({
          id, role: "image", media_type: candidate.mediaType, loading: "bundled", size: candidate.bytes.length,
          digest: { algorithm: "sha-256", value: new Uint8Array(await crypto.subtle.digest("SHA-256", candidate.bytes as BufferSource)) },
          width: candidate.width, height: candidate.height, data: candidate.bytes,
        });
        remaining -= candidate.bytes.length + ASSET_OVERHEAD_BYTES;
        outcome = { id, width: candidate.width, height: candidate.height };
      }
    }
    bySource.set(key, outcome);
    return outcome;
  };

  for (const block of converted.blocks) {
    if (block._type === "block") { blocks.push(block as HailSpt2TextBlock); continue; }
    let outcome = await resolve(block);
    // A reused asset still counts toward the block and pixel budgets each time it appears.
    if (typeof outcome !== "string" && (images >= policy.maxImages || pixels + outcome.width * outcome.height > policy.maxTotalPixels)) {
      outcome = "image-linked-budget";
    }
    const label = block.alt ?? "Image";
    if (typeof outcome !== "string") {
      images++; pixels += outcome.width * outcome.height;
      blocks.push({ _type: "spt.image", asset: outcome.id, alt: block.alt ?? NO_DESCRIPTION });
      // Image blocks carry no destination, so a linked image is followed by its link.
      if (block.link) blocks.push(linkBlock(label, block.link, "caption"));
      continue;
    }
    note(outcome);
    if (outcome === "tracking-pixel-dropped") continue;
    // The article an image links to is more useful than the image file itself.
    const destination = block.link ?? (block.source.kind === "remote" ? block.source.url : null);
    if (destination) blocks.push(linkBlock(block.link ? label : `Image: ${label}`, destination, "normal"));
    else if (block.alt) blocks.push({ _type: "block", style: "caption", children: [{ _type: "span", text: `Image: ${block.alt}`, marks: [] }], markDefs: [] });
  }

  // Every bundled asset must be referenced; one refused only by the block or pixel budget is not.
  const used = new Set(blocks.flatMap(block => block._type === "spt.image" ? [block.asset] : []));
  const bundled = assets.filter(asset => used.has(asset.id));
  if (!blocks.length) throw new BridgeInputError("empty", "The message has no readable content");

  const statement = origin(converted, options);
  const [first, ...rest] = bundled;
  const body: HailSpt2Body | HailSpt3Body = first
    ? { version: 1, profile: "spt-3", origin: statement, assets: { version: 1, assets: [first, ...rest] }, blocks }
    : { version: 1, profile: "spt-2", origin: statement, blocks: blocks as HailSpt2TextBlock[] };
  try {
    const bytes = body.profile === "spt-3" ? encodePayload("hail.body.spt-3", body) : encodePayload("hail.body.spt-2", body);
    return { body, bytes, diagnostics };
  } catch (error) {
    // For example a sender address outside the origin syntax, which the converter accepts more loosely.
    throw new BridgeInputError("unparseable", `The converted message is not a valid body: ${error instanceof Error ? error.message : "rejected"}`);
  }
}
