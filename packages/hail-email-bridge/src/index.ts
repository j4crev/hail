export { convertEmail } from "./convert.js";
export {
  assembleBody, CURRENT_IMAGE_POLICY, type AssembledBody, type AssembleOptions, type ImagePolicy, type RemoteImageResolver,
} from "./assemble.js";
export { TRUNCATION_NOTICE } from "./builder.js";
export { blockItems, blockTextBytes, DEFAULT_LIMITS, UNBOUNDED_LIMITS, type ConversionLimits } from "./limits.js";
export { probeImage, type ImageFormat, type ImageProbe } from "./image-probe.js";
export {
  BridgeInputError, type BridgeBlock, type BridgeImageRef, type BridgeInputErrorCode, type BridgeLink, type BridgeSpan,
  type BridgeTextBlock, type ConvertedEmail, type DiagnosticCode, type Diagnostics, type EmailSource, type InlineImage,
} from "./types.js";
