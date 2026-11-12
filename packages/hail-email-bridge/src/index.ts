export { convertEmail } from "./convert.ts";
export {
  assembleBody, CURRENT_IMAGE_POLICY, type AssembledBody, type AssembleOptions, type ImagePolicy, type RemoteImageResolver,
} from "./assemble.ts";
export { TRUNCATION_NOTICE } from "./builder.ts";
export { blockItems, blockTextBytes, DEFAULT_LIMITS, UNBOUNDED_LIMITS, type ConversionLimits } from "./limits.ts";
export { probeImage, type ImageFormat, type ImageProbe } from "./image-probe.ts";
export {
  BridgeInputError, type BridgeBlock, type BridgeImageRef, type BridgeInputErrorCode, type BridgeLink, type BridgeSpan,
  type BridgeTextBlock, type ConvertedEmail, type DiagnosticCode, type Diagnostics, type EmailSource, type InlineImage,
} from "./types.ts";
