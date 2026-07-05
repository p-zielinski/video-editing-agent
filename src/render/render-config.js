import { DEFAULT_RENDER_STYLE_PRESETS } from "./style-presets.js";

export const ENCODE_PROFILES = {
  production: {
    videoCodec: "libx264",
    preset: "slow",
    crf: 18,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "192k",
  },
  draft: {
    videoCodec: "libx264",
    preset: "ultrafast",
    crf: 23,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "128k",
  },
};

const DEFAULT_FORMAT_DIMENSIONS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
};

export function resolveEncodeProfile(profileName = "production") {
  return ENCODE_PROFILES[profileName] ?? ENCODE_PROFILES.production;
}

export function resolveOutputDimensions(format, recipe) {
  const presets = recipe?.renderStylePresets?.formats?.[format];
  if (presets?.width && presets?.height) {
    return { width: presets.width, height: presets.height };
  }
  return DEFAULT_FORMAT_DIMENSIONS[format] ?? DEFAULT_FORMAT_DIMENSIONS["16:9"];
}

export function resolveStylePresets(recipe) {
  const custom = recipe?.renderStylePresets ?? {};
  return {
    subtitles: { ...DEFAULT_RENDER_STYLE_PRESETS.subtitles, ...custom.subtitles },
    overlays: { ...DEFAULT_RENDER_STYLE_PRESETS.overlays, ...custom.overlays },
    formats: { ...DEFAULT_RENDER_STYLE_PRESETS.formats, ...custom.formats },
  };
}

export function formatToFileSuffix(format) {
  return format.replace(":", "x");
}

/** Named bundles for render iteration (merged with explicit CLI flags; CLI wins). */
export const RENDER_PROFILES = {
  preview: {
    encodeProfile: "draft",
    skipCreative: true,
    skipSubtitles: true,
    skipOverlays: true,
    skipAudioMix: true,
    skipColorGrade: true,
  },
  iterate: {
    encodeProfile: "draft",
    skipSubtitles: true,
    skipOverlays: true,
    keepTmp: true,
  },
  production: {},
};

export function resolveRenderProfile(profileName) {
  if (!profileName) {
    return {};
  }
  return RENDER_PROFILES[profileName] ?? {};
}

function mergeSkipFlag(explicit, profileValue) {
  if (explicit === true) {
    return true;
  }
  if (explicit === false) {
    return false;
  }
  return profileValue === true;
}

export function buildExecuteRenderOptions(args) {
  const profile = resolveRenderProfile(args.renderProfile);
  return {
    dryRun: args.dryRun === true,
    force: args.force === true,
    outputId: args.outputId,
    format: args.format,
    encodeProfile: args.encodeProfile ?? profile.encodeProfile ?? "production",
    skipCreative: mergeSkipFlag(args.skipCreative, profile.skipCreative),
    skipSubtitles: mergeSkipFlag(args.skipSubtitles, profile.skipSubtitles),
    skipOverlays: mergeSkipFlag(args.skipOverlays, profile.skipOverlays),
    skipAudioMix: mergeSkipFlag(args.skipAudioMix, profile.skipAudioMix),
    skipColorGrade: mergeSkipFlag(args.skipColorGrade, profile.skipColorGrade),
    keepTmp: args.keepTmp === true || profile.keepTmp === true,
    fromPass: args.fromPass,
    allowRenderWarnings: args.allowRenderWarnings === true,
  };
}
