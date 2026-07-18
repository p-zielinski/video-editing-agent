import { buildOutputTimeline, resolveWordIndexForSegment } from "../lib/build-output-timeline.js";
import { buildKeepRanges } from "../render/audio-cuts.js";
import {
  findL2SegmentIdForSourceTime,
  isSlowBreathNarrativeSegment,
  resolveL2OutputRangeSec,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
  resolveSegmentCaps,
  shouldAllowRetentionEnrichForL2,
  shouldSkipRetentionBeatEnrich,
} from "../lib/narrative-profile.js";
import {
  buildSpatialRefFromAnchor,
  deriveClipIdFromSceneId,
  findAnchorNearTimestamp,
} from "./spatial-ref.js";
import { buildTopSceneRanks } from "./scene-rank.js";
import {
  isChronologicalFirstScene,
  isSetupNarrativeScene,
  resolveHookWordInpointSec,
  segmentOpensWithGreeting,
} from "./shorts-greeting.js";

export const SHORT_HOOK_SEGMENT_ID = "enrich_short_hook_01";
const DEFAULT_SHORT_HOOK_MAX_SEC = 3;

export const DEFAULT_SHORTS_RETENTION_PROFILE = {
  enabled: false,
  hookWindowSec: 3,
  retentionBeatIntervalSec: 25,
  retentionBeatToleranceSec: 5,
  minRetentionBeats: 2,
  requireHookMoment: true,
  requireHookOverlay: true,
  maxHookOverlayDurationSec: 4,
  techniquePack: "shorts_retention_2026",
  mode: "shorts",
  dynamicBeatCadence: true,
};

/** Softer cadence for 16:9 vlog main — subtle variety, not constant flashing. */
export const DEFAULT_VLOG_RETENTION_PROFILE = {
  enabled: false,
  hookWindowSec: 3,
  retentionBeatIntervalSec: 45,
  retentionBeatToleranceSec: 8,
  minRetentionBeats: 2,
  requireHookMoment: false,
  requireHookOverlay: false,
  techniquePack: "youtube_vlog_2026",
  mode: "vlog",
};

/** Preferred techniques per beat slot for vlog 16:9 (rotate for variety). */
export const VLOG_RETENTION_TECHNIQUE_ROTATION = [
  "zoom_slow_push",
  "ken_burns_light",
  "music_swell",
  "silence_beat",
];

/** Aggressive techniques for shorts retention beats. */
export const SHORTS_RETENTION_TECHNIQUE_ROTATION = [
  "pattern_interrupt",
  "retention_beat",
  "snap_zoom",
  "jump_cut",
];

const HOOK_TECHNIQUE_PREFIX = "hook_";
const LARGE_HOOK_OVERLAY_STYLES = new Set([
  "hook_large",
  "hook_question",
  "hook_number",
]);
const LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC = 15;

/**
 * @param {string} [userContext]
 * @returns {object|null}
 */
export function parseRetentionFromContext(userContext = "") {
  const text = String(userContext).toLowerCase();

  if (/shorts:\s*retention/.test(text)) {
    return {
      enabled: true,
      techniquePack: "shorts_retention_2026",
    };
  }

  if (/shorts:\s*energy\s*high/.test(text)) {
    return { enabled: true };
  }

  return null;
}

/**
 * @param {Array<{ outputKind?: string }>} [outputs]
 */
export function hasShortOutput(outputs = []) {
  return outputs.some((output) => output.outputKind === "short");
}

/**
 * Planned short deliverable when recipe outputs are not materialized yet.
 * @param {string[]} [requiredFormats]
 */
export function hasShortFormatRequired(requiredFormats = []) {
  return requiredFormats.includes("9:16");
}

/** Short-only deliverable — 9:16 without landscape main format. */
export function isShortOnlyFormatRequired(requiredFormats = []) {
  return requiredFormats.includes("9:16") && !requiredFormats.includes("16:9");
}

/** Main vlog deliverable — 16:9 present and not short-only. */
export function hasVlogFormatRequired(requiredFormats = []) {
  return requiredFormats.includes("16:9") && !isShortOnlyFormatRequired(requiredFormats);
}

/** Dual deliverable — both landscape main and vertical short requested. */
export function hasDualFormatRequired(requiredFormats = []) {
  return requiredFormats.includes("16:9") && requiredFormats.includes("9:16");
}

/**
 * @param {Array<{ outputKind?: string, format?: string }>} [outputs]
 */
export function hasMainOutput(outputs = []) {
  return outputs.some((output) => output.outputKind === "main" || output.format === "16:9");
}

/**
 * @param {object} [options]
 */
export function shouldEnableShortsRetention({
  outputs = [],
  requiredFormats = [],
  creativityProfile = {},
  userContext = "",
  shortsRetentionProfile = {},
} = {}) {
  if (shortsRetentionProfile.enabled === false) {
    return false;
  }
  if (shortsRetentionProfile.enabled === true) {
    return true;
  }
  if (
    hasShortOutput(outputs)
    || isShortOnlyFormatRequired(requiredFormats)
    || hasDualFormatRequired(requiredFormats)
  ) {
    return true;
  }
  if (creativityProfile.level === "shorts") {
    return true;
  }
  if (parseRetentionFromContext(userContext)) {
    return true;
  }
  return false;
}

/**
 * @param {object} [options]
 */
export function shouldEnableVlogRetention({
  outputs = [],
  requiredFormats = [],
  vlogRetentionProfile = {},
} = {}) {
  if (vlogRetentionProfile.enabled === false) {
    return false;
  }
  if (vlogRetentionProfile.enabled === true) {
    return true;
  }
  if (hasMainOutput(outputs) || hasVlogFormatRequired(requiredFormats)) {
    return true;
  }
  return false;
}

/**
 * @param {object} overrides
 * @param {{ outputs?: object[], requiredFormats?: string[] }} [context]
 */
export function mergeVlogRetentionProfile(overrides = {}, context = {}) {
  const { outputs = [], requiredFormats = [] } = context;
  const { enabled: _ignoredEnabled, ...defaultsWithoutEnabled } = DEFAULT_VLOG_RETENTION_PROFILE;
  const draft = {
    ...defaultsWithoutEnabled,
    ...overrides,
  };

  const enabled = shouldEnableVlogRetention({
    outputs,
    requiredFormats,
    vlogRetentionProfile: overrides,
  });

  return {
    ...draft,
    enabled,
    mode: "vlog",
  };
}

/**
 * Whether V22 validation / retention grammar applies to a recipe artifact.
 * v2.0/v2.1 without explicit opt-in skip retention even when short outputs exist.
 */
export function shouldRunShortsRetentionValidation({
  recipeVersion = "2.2",
  outputs = [],
  requiredFormats = [],
  creativityProfile = {},
  userContext = "",
  shortsRetentionProfile = {},
} = {}) {
  if (shortsRetentionProfile.enabled === false) {
    return false;
  }
  if (shortsRetentionProfile.enabled === true) {
    return true;
  }
  if (parseRetentionFromContext(userContext)) {
    return true;
  }

  const legacy = recipeVersion === "2.0" || recipeVersion === "2.1";
  if (legacy) {
    return false;
  }

  return shouldEnableShortsRetention({
    outputs,
    requiredFormats,
    creativityProfile,
    userContext,
    shortsRetentionProfile,
  });
}

/**
 * Whether V22-VLOG validation / vlog retention grammar applies to a recipe artifact.
 * v2.0/v2.1 without explicit opt-in skip vlog retention even when main outputs exist.
 */
export function shouldRunVlogRetentionValidation({
  recipeVersion = "2.2",
  outputs = [],
  requiredFormats = [],
  vlogRetentionProfile = {},
} = {}) {
  if (vlogRetentionProfile.enabled === false) {
    return false;
  }
  if (vlogRetentionProfile.enabled === true) {
    return true;
  }

  const legacy = recipeVersion === "2.0" || recipeVersion === "2.1";
  if (legacy) {
    return false;
  }

  return shouldEnableVlogRetention({
    outputs,
    requiredFormats,
    vlogRetentionProfile,
  });
}

/**
 * @param {object} overrides
 * @param {{ packRetentionDefaults?: object, userContext?: string, outputs?: object[], requiredFormats?: string[], creativityProfile?: object }} [context]
 */
export function mergeShortsRetentionProfile(overrides = {}, context = {}) {
  const {
    packRetentionDefaults = {},
    userContext = "",
    outputs = [],
    requiredFormats = [],
    creativityProfile = {},
  } = context;

  const contextOverrides = parseRetentionFromContext(userContext) ?? {};
  const { enabled: _ignoredEnabled, ...defaultsWithoutEnabled } = DEFAULT_SHORTS_RETENTION_PROFILE;
  const draft = {
    ...defaultsWithoutEnabled,
    ...packRetentionDefaults,
    ...contextOverrides,
    ...overrides,
  };

  const enabled = shouldEnableShortsRetention({
    outputs,
    requiredFormats,
    creativityProfile,
    userContext,
    shortsRetentionProfile: { ...overrides, ...contextOverrides },
  });

  return {
    ...draft,
    enabled,
  };
}

/**
 * Effective retention beat interval for shorts — denser cadence on reels ≤45s.
 * @param {object} profile
 * @param {number} durationSec
 */
export function resolveShortRetentionInterval(profile = {}, durationSec = 60) {
  const base = profile.retentionBeatIntervalSec
    ?? DEFAULT_SHORTS_RETENTION_PROFILE.retentionBeatIntervalSec;

  if (profile.dynamicBeatCadence === false) {
    return base;
  }

  if (durationSec <= 45) {
    return Math.min(base, 10);
  }
  if (durationSec <= 60) {
    return Math.min(base, 15);
  }
  return base;
}

/**
 * @param {number} durationSec
 * @param {object} profile
 */
export function computeScaledMinRetentionBeats(durationSec, profile) {
  const base = profile.minRetentionBeats ?? DEFAULT_SHORTS_RETENTION_PROFILE.minRetentionBeats;
  const interval = profile.mode === "vlog"
    ? (profile.retentionBeatIntervalSec ?? DEFAULT_VLOG_RETENTION_PROFILE.retentionBeatIntervalSec)
    : resolveShortRetentionInterval(profile, durationSec);

  if (durationSec <= 30) {
    return base;
  }

  const scaled = Math.max(1, Math.floor(durationSec / interval));
  return Math.max(base, scaled);
}

/**
 * Duration used for retention beat planning — prefer short output length over source footage.
 * @param {{ outputs?: object[], batchContext?: object, targetDurationSec?: number }} [options]
 */
export function resolveShortOutputDurationSec({
  outputs = [],
  batchContext = {},
  targetDurationSec,
} = {}) {
  const shortOutputs = outputs.filter((output) => output.outputKind === "short");
  let maxTimelineSec = 0;

  for (const output of shortOutputs) {
    if (output.targetDurationSec) {
      maxTimelineSec = Math.max(maxTimelineSec, output.targetDurationSec);
    }
    for (const seg of output.timeline ?? []) {
      const end = seg.outputEndSec
        ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
      maxTimelineSec = Math.max(maxTimelineSec, end);
    }
  }

  if (maxTimelineSec > 0) {
    return maxTimelineSec;
  }

  if (batchContext.shortsMaxDurationSec) {
    return batchContext.shortsMaxDurationSec;
  }

  return targetDurationSec ?? 60;
}

/**
 * Duration used for vlog retention beat planning — prefer main output length.
 * @param {{ outputs?: object[], batchContext?: object, targetDurationSec?: number }} [options]
 */
export function resolveMainOutputDurationSec({
  outputs = [],
  batchContext = {},
  targetDurationSec,
} = {}) {
  const mainOutputs = outputs.filter(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  let maxTimelineSec = 0;

  for (const output of mainOutputs) {
    if (output.targetDurationSec) {
      maxTimelineSec = Math.max(maxTimelineSec, output.targetDurationSec);
    }
    for (const seg of output.timeline ?? []) {
      const end = seg.outputEndSec
        ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
      maxTimelineSec = Math.max(maxTimelineSec, end);
    }
  }

  if (maxTimelineSec > 0) {
    return maxTimelineSec;
  }

  if (batchContext.targetDurationSec) {
    return batchContext.targetDurationSec;
  }

  return targetDurationSec ?? 600;
}

function resolveRetentionDefaults(mode = "shorts") {
  return mode === "vlog" ? DEFAULT_VLOG_RETENTION_PROFILE : DEFAULT_SHORTS_RETENTION_PROFILE;
}

/**
 * Ordered technique id per beat slot — cycles rotation for subtle variety.
 * @param {number} beatCount
 * @param {"vlog"|"shorts"} [mode]
 */
export function buildRetentionTechniqueRotation(beatCount, mode = "shorts") {
  const rotation = mode === "vlog"
    ? VLOG_RETENTION_TECHNIQUE_ROTATION
    : SHORTS_RETENTION_TECHNIQUE_ROTATION;

  const result = [];
  for (let i = 0; i < beatCount; i += 1) {
    result.push(rotation[i % rotation.length]);
  }
  return result;
}

/**
 * Idealne pozycje beatów (po hook window) do briefu directora.
 * Gwarantuje co najmniej minRetentionBeats pozycji w obrębie durationSec.
 * @param {number} durationSec
 * @param {object} profile
 * @param {{ mode?: "vlog"|"shorts" }} [options]
 */
export function computeRetentionBeatTargets(durationSec, profile = {}, { mode = "shorts" } = {}) {
  const resolvedMode = profile.mode ?? mode;
  const defaults = resolveRetentionDefaults(resolvedMode);
  const hookWindow = profile.hookWindowSec ?? defaults.hookWindowSec;
  const interval = resolvedMode === "shorts"
    ? resolveShortRetentionInterval(profile, durationSec)
    : (profile.retentionBeatIntervalSec ?? defaults.retentionBeatIntervalSec);
  const effectiveProfile = { ...defaults, ...profile };
  const minBeats = computeScaledMinRetentionBeats(durationSec, effectiveProfile);
  const span = durationSec - hookWindow;

  if (minBeats <= 0 || span <= 0) {
    return [];
  }

  const targets = [];
  let cursor = hookWindow + interval;
  while (targets.length < minBeats && cursor < durationSec) {
    targets.push(Math.round(cursor * 10) / 10);
    cursor += interval;
  }

  while (targets.length < minBeats) {
    const slot = targets.length + 1;
    const pos = hookWindow + (span * slot) / (minBeats + 1);
    const rounded = Math.round(Math.min(pos, durationSec - 0.1) * 10) / 10;
    if (!targets.some((existing) => Math.abs(existing - rounded) < 0.5)) {
      targets.push(rounded);
    } else {
      targets.push(Math.round((hookWindow + span * 0.5) * 10) / 10);
    }
  }

  return targets.sort((a, b) => a - b).slice(0, minBeats);
}

/**
 * @param {object} profile
 * @param {number[]} [beatTargets]
 * @param {{ mode?: "vlog"|"shorts", techniqueRotation?: string[] }} [options]
 */
export function formatRetentionGrammarForPrompt(profile, beatTargets = [], options = {}) {
  if (!profile?.enabled) {
    return null;
  }

  const mode = profile.mode ?? options.mode ?? "shorts";
  const tolerance = profile.retentionBeatToleranceSec
    ?? resolveRetentionDefaults(mode).retentionBeatToleranceSec;
  const beats = beatTargets.length
    ? beatTargets.map((sec) => `${sec}s`).join(", ")
    : `co ${profile.retentionBeatIntervalSec}s (±${tolerance}s)`;
  const techniqueHint = options.techniqueRotation?.length
    ? options.techniqueRotation.join(" → ")
    : (mode === "vlog"
      ? VLOG_RETENTION_TECHNIQUE_ROTATION.join(" → ")
      : "pattern_interrupt | retention_beat | zoom | cut");

  const rules = mode === "vlog"
    ? [
      `Vlog 16:9 — subtelna retencja co ${profile.retentionBeatIntervalSec}s (±${tolerance}s), bez ciągłego migania`,
      `Retention beats: ${beats}`,
      `Min beats: ${profile.minRetentionBeats} (skalowane dla >30s)`,
      `Preferuj rotację: ${techniqueHint} — unikaj jump_cut / hard_cut_energy na beatach`,
      `retentionRole: beat na creativeMoments; payoff tylko przy kulminacji`,
    ]
    : [
      `0–${profile.hookWindowSec}s: hook — najlepszy moment (nie chronologia), tekst + wizualny punch`,
      `Retention beats: ${beats}`,
      `Min beats: ${profile.minRetentionBeats} (skalowane dla >30s)`,
      `Overlay budget: max 1 duży napis na ${LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC}s`,
      `retentionRole: hook | beat | payoff na creativeMoments; role cta na textOverlays (call-to-action, nie kulminacja)`,
      `textOverlays: style hook_large | hook_question | hook_number | emphasis | chapter_card; role hook | retention_beat | cta`,
    ];

  return {
    mode,
    hookWindowSec: profile.hookWindowSec,
    rules,
    requireHookMoment: profile.requireHookMoment,
    requireHookOverlay: profile.requireHookOverlay,
    techniquePack: profile.techniquePack,
    techniqueRotation: options.techniqueRotation,
  };
}

/**
 * Brief-only hints when recipe lacks retention beats near cadence targets.
 * Does not mutate the recipe.
 * @param {object} recipe
 * @param {object} [profile]
 * @param {{ mode?: "vlog"|"shorts" }} [options]
 */
export function suggestRetentionMoments(recipe, profile = {}, { mode = "vlog" } = {}) {
  const outputs = recipe?.outputs ?? [];
  const mainOutput = outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  if (!mainOutput) {
    return [];
  }

  const resolvedMode = profile.mode ?? mode;
  const defaults = resolveRetentionDefaults(resolvedMode);
  const mergedProfile = { ...defaults, ...profile };
  const tolerance = mergedProfile.retentionBeatToleranceSec ?? defaults.retentionBeatToleranceSec;
  const durationSec = resolveMainOutputDurationSec({
    outputs,
    batchContext: recipe.batchContext ?? {},
  });
  const targets = computeRetentionBeatTargets(durationSec, mergedProfile, { mode: resolvedMode });
  const rotation = buildRetentionTechniqueRotation(targets.length, resolvedMode);

  const beatMoments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId && isRetentionBeatMoment(moment),
  );

  const suggestions = [];
  for (let i = 0; i < targets.length; i += 1) {
    const targetSec = targets[i];
    const hasNearby = beatMoments.some((moment) => {
      const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
      return Math.abs(anchor - targetSec) <= tolerance;
    });
    if (!hasNearby) {
      suggestions.push({
        outputId: mainOutput.outputId,
        targetSec,
        suggestedTechniqueId: rotation[i % rotation.length],
        retentionRole: "beat",
        suggestion:
          `Brak retention beat w ±${tolerance}s od ${targetSec}s — rozważ `
          + `${rotation[i % rotation.length]} z retentionRole: beat`,
      });
    }
  }

  return suggestions;
}

/**
 * @param {string} techniqueId
 */
export function isHookTechniqueId(techniqueId) {
  return techniqueId === "snap_zoom"
    || techniqueId === "hook_visual_punch"
    || techniqueId.startsWith(HOOK_TECHNIQUE_PREFIX);
}

/**
 * @param {object} moment
 */
export function isHookMoment(moment) {
  if (moment.retentionRole === "hook") {
    return true;
  }
  if (moment.retentionRole) {
    return false;
  }
  return isHookTechniqueId(moment.techniqueId);
}

/**
 * Primary: retentionRole beat. Technique fallback only when role is unset.
 * @param {object} moment
 */
export function isRetentionBeatMoment(moment) {
  if (moment.retentionRole === "beat") {
    return true;
  }
  if (moment.retentionRole) {
    return false;
  }
  return moment.techniqueId === "retention_beat"
    || moment.techniqueId === "pattern_interrupt";
}

/**
 * @param {object} overlay
 */
export function isLargeHookOverlay(overlay) {
  if (overlay.role === "hook") {
    return true;
  }
  return LARGE_HOOK_OVERLAY_STYLES.has(overlay.style);
}

export {
  LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC,
  LARGE_HOOK_OVERLAY_STYLES,
};

function resolveSegmentClipId(segment) {
  return segment?.audioRef?.clipId
    ?? segment?.videoRef?.clipId
    ?? segment?.sourceRef?.clipId
    ?? null;
}

function resolveOutputForMapping(outputs, outputKind = "main") {
  if (outputKind === "short") {
    return outputs.find((output) => output.outputKind === "short" || output.format === "9:16");
  }
  return outputs.find((output) => output.outputKind === "main" || output.format === "16:9");
}

function resolveMappingOutputs(recipeOrOutputs) {
  if (Array.isArray(recipeOrOutputs)) {
    return recipeOrOutputs;
  }
  return recipeOrOutputs?.outputs ?? [];
}

function mapSourceOffsetInSegment(segment, sourceTimeSec, wordIndex) {
  const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const sourceOut = segment.audioOutSec ?? segment.videoOutSec ?? sourceIn;

  if (!segment.cuts?.length || !wordIndex?.words?.length) {
    return sourceTimeSec - sourceIn;
  }

  const keepRanges = buildKeepRanges(segment.cuts, wordIndex, sourceIn, sourceOut);
  if (!keepRanges?.length) {
    return sourceTimeSec - sourceIn;
  }

  let outputOffset = 0;
  for (const range of keepRanges) {
    const rangeSourceStart = sourceIn + range.start;
    const rangeSourceEnd = sourceIn + range.end;
    if (sourceTimeSec < rangeSourceStart) {
      break;
    }
    if (sourceTimeSec <= rangeSourceEnd + 0.001) {
      return outputOffset + Math.max(0, sourceTimeSec - rangeSourceStart);
    }
    outputOffset += range.end - range.start;
  }

  return outputOffset;
}

/**
 * Map clip source time to output timeline position by walking output segments.
 * Falls back to sourceTimeSec when no timeline is materialized yet (pre-recipe brief).
 * @param {object|object[]} recipeOrOutputs — recipe or outputs array
 * @param {string} clipId
 * @param {number} sourceTimeSec
 * @param {{ outputKind?: "main"|"short", wordIndexes?: object[] }} [options]
 * @returns {number|null}
 */
export function mapSourceTimeToOutputSec(recipeOrOutputs, clipId, sourceTimeSec, options = {}) {
  if (!Number.isFinite(sourceTimeSec)) {
    return null;
  }

  const outputs = resolveMappingOutputs(recipeOrOutputs);
  const outputKind = options.outputKind ?? "main";
  const output = resolveOutputForMapping(outputs, outputKind);
  const timeline = output?.timeline ?? [];

  if (!timeline.length) {
    return Math.round(sourceTimeSec * 10) / 10;
  }

  const enrichedTimeline = buildOutputTimeline(output, {
    wordIndexes: options.wordIndexes,
  });

  for (const segment of enrichedTimeline) {
    if (resolveSegmentClipId(segment) !== clipId) {
      continue;
    }

    const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;
    const sourceOut = segment.audioOutSec ?? segment.videoOutSec ?? sourceIn;
    if (sourceTimeSec < sourceIn || sourceTimeSec >= sourceOut) {
      continue;
    }

    const outputStartSec = segment.outputStartSec ?? 0;
    const wordIndex = resolveWordIndexForSegment(segment, options.wordIndexes);
    const sourceOffset = mapSourceOffsetInSegment(segment, sourceTimeSec, wordIndex);
    return Math.round((outputStartSec + sourceOffset) * 10) / 10;
  }

  return null;
}

/**
 * Collect anchor candidates from audio energy peaks and L1 keyMoments (via timeline).
 * @param {object} audioIndex
 * @param {object} abstraction
 * @param {object} [timelineIndex]
 * @param {{ recipe?: object, outputs?: object[], outputKind?: "main"|"short" }} [mapContext]
 */
function collectRetentionAnchorCandidates(audioIndex, abstraction, timelineIndex, mapContext = {}) {
  const candidates = [];
  const mappingSource = mapContext.recipe ?? mapContext.outputs;
  const outputKind = mapContext.outputKind ?? "main";
  const { wordIndexes } = mapContext;

  function attachOutputSec(sourceTimeSec, clipId) {
    const mapped = mappingSource
      ? mapSourceTimeToOutputSec(mappingSource, clipId, sourceTimeSec, { outputKind, wordIndexes })
      : Math.round(sourceTimeSec * 10) / 10;
    return mapped ?? Math.round(sourceTimeSec * 10) / 10;
  }

  for (const clip of audioIndex?.clips ?? []) {
    for (const peak of clip.energyPeaks ?? []) {
      const mid = Math.round(((peak.startSec + peak.endSec) / 2) * 10) / 10;
      candidates.push({
        timeSec: mid,
        outputSec: attachOutputSec(mid, clip.clipId),
        clipId: clip.clipId,
        source: "energyPeak",
      });
    }
  }

  const l1ByScene = new Map((abstraction?.L1 ?? []).map((entry) => [entry.sceneId, entry]));
  const sceneById = new Map((timelineIndex?.scenes ?? []).map((scene) => [scene.sceneId, scene]));
  const words = timelineIndex?.words ?? [];

  for (const l2 of abstraction?.L2 ?? []) {
    for (const sceneId of l2.sceneIds ?? []) {
      const l1 = l1ByScene.get(sceneId);
      const scene = sceneById.get(sceneId);
      if (!l1?.keyMoments?.length || !scene) {
        continue;
      }

      for (const momentLabel of l1.keyMoments) {
        const normalized = String(momentLabel).toLowerCase();
        const word = words.find(
          (w) => w.start >= scene.startSec
            && w.start < scene.endSec
            && String(w.word).toLowerCase() === normalized,
        );
        const timeSec = word
          ? Math.round(word.start * 10) / 10
          : Math.round((scene.startSec + scene.durationSec * 0.35) * 10) / 10;

        candidates.push({
          timeSec,
          outputSec: attachOutputSec(timeSec, scene.clipId),
          clipId: scene.clipId,
          source: word ? "l1_keyMoment" : "l2_scene",
          label: momentLabel,
        });
      }
    }
  }

  return candidates;
}

const ENRICH_BEAT_DURATION_MIN_SEC = 0.3;
const ENRICH_BEAT_DURATION_MAX_SEC = 0.8;
/** Skip enrich anchors this long after an energy peak that already has a beat. */
const ENRICH_PEAK_COOLDOWN_SEC = 10;

/**
 * Remap retention-beat techniques that violate the safe creativity gate.
 * At safe, always use cut_on_beat so backfill never trips zoom density/gap budgets.
 * @param {string} techniqueId
 * @param {string} [creativityLevel]
 */
export function resolveEnrichBeatTechniqueId(techniqueId, creativityLevel = "balanced") {
  if (creativityLevel === "safe") {
    return "cut_on_beat";
  }
  return techniqueId;
}

const SPATIAL_REF_TECHNIQUE_IDS = new Set([
  "zoom_slow_push",
  "ken_burns_light",
  "reframe_follow_subject",
]);

function resolveSegmentAtOutputSec(mainOutput, outputStartSec) {
  const timeline = buildOutputTimeline(mainOutput);
  for (const segment of timeline) {
    const start = segment.outputStartSec ?? 0;
    const end = segment.outputEndSec
      ?? start + (segment.videoOutSec - segment.videoInSec);
    if (outputStartSec >= start && outputStartSec < end) {
      const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;
      return {
        segment,
        sourceTimeSec: (outputStartSec - start) + sourceIn,
      };
    }
  }
  return null;
}

function findSceneAtSourceTime(timelineIndex, clipId, sourceTimeSec) {
  if (!clipId || !Number.isFinite(sourceTimeSec)) {
    return null;
  }
  return (timelineIndex?.scenes ?? []).find(
    (scene) => scene.clipId === clipId
      && sourceTimeSec >= scene.startSec
      && sourceTimeSec < scene.endSec,
  ) ?? null;
}

/**
 * Resolve spatialRef for enriched retention beats that benefit from a face/subject anchor.
 * Falls back to timestamp-only spatialRef when scene anchors are unavailable.
 *
 * @param {{ spatialIndex?: object, timelineIndex?: object, outputStartSec: number, mainOutput: object, techniqueId: string }} params
 * @returns {object|undefined}
 */
export function resolveSpatialRefForBeat({
  spatialIndex,
  timelineIndex,
  outputStartSec,
  mainOutput,
  techniqueId,
}) {
  if (!SPATIAL_REF_TECHNIQUE_IDS.has(techniqueId)) {
    return undefined;
  }
  if (!mainOutput?.timeline?.length) {
    return undefined;
  }

  const resolved = resolveSegmentAtOutputSec(mainOutput, outputStartSec);
  if (!resolved) {
    return undefined;
  }

  const clipId = resolved.segment.videoRef?.clipId
    ?? resolved.segment.audioRef?.clipId
    ?? resolved.segment.sourceRef?.clipId
    ?? null;

  let sceneId = resolved.segment.videoRef?.sceneId
    ?? resolved.segment.audioRef?.sceneId
    ?? null;

  if (!sceneId) {
    const scene = findSceneAtSourceTime(timelineIndex, clipId, resolved.sourceTimeSec);
    sceneId = scene?.sceneId ?? null;
  }

  if (!sceneId) {
    return undefined;
  }

  const anchor = findAnchorNearTimestamp(spatialIndex, sceneId, resolved.sourceTimeSec, "face")
    ?? findAnchorNearTimestamp(spatialIndex, sceneId, resolved.sourceTimeSec, "subject")
    ?? findAnchorNearTimestamp(spatialIndex, sceneId, resolved.sourceTimeSec);

  if (!anchor) {
    return {
      clipId: clipId ?? deriveClipIdFromSceneId(sceneId),
      sceneId,
      timestampSec: resolved.sourceTimeSec,
    };
  }

  return buildSpatialRefFromAnchor(
    sceneId,
    clipId ?? deriveClipIdFromSceneId(sceneId),
    anchor,
  );
}

function findNearestAnchor(candidates, idealSec, toleranceSec, usedCandidates = new Set()) {
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    if (usedCandidates.has(candidate)) {
      continue;
    }
    const distance = Math.abs(candidate.outputSec - idealSec);
    if (distance <= toleranceSec && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function enrichBeatDurationSec(slotIndex) {
  const step = (ENRICH_BEAT_DURATION_MAX_SEC - ENRICH_BEAT_DURATION_MIN_SEC) / 5;
  return Math.min(
    ENRICH_BEAT_DURATION_MAX_SEC,
    ENRICH_BEAT_DURATION_MIN_SEC + (slotIndex % 6) * step,
  );
}

function hasBeatNearSec(beatMoments, targetSec, toleranceSec) {
  return beatMoments.some((moment) => {
    const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
    return Math.abs(anchor - targetSec) <= toleranceSec;
  });
}

function collectEnergyPeakOutputSecs(audioIndex, mapContext = {}) {
  const mappingSource = mapContext.recipe ?? mapContext.outputs;
  const outputKind = mapContext.outputKind ?? "main";
  const { wordIndexes } = mapContext;
  const peaks = [];

  for (const clip of audioIndex?.clips ?? []) {
    for (const peak of clip.energyPeaks ?? []) {
      const mid = Math.round(((peak.startSec + peak.endSec) / 2) * 10) / 10;
      const mapped = mappingSource
        ? mapSourceTimeToOutputSec(mappingSource, clip.clipId, mid, { outputKind, wordIndexes })
        : mid;
      peaks.push(mapped ?? mid);
    }
  }

  return peaks.sort((a, b) => a - b);
}

function findEnergyPeakNearOutputSec(peakOutputSecs, outputSec, toleranceSec) {
  for (const peakSec of peakOutputSecs) {
    if (Math.abs(outputSec - peakSec) <= toleranceSec) {
      return peakSec;
    }
  }
  return null;
}

function isInPeakCooldown(outputSec, cooldownPeakSecs, cooldownSec) {
  return cooldownPeakSecs.some(
    (peakSec) => outputSec >= peakSec && outputSec < peakSec + cooldownSec,
  );
}

function peaksWithNearbyBeats(peakOutputSecs, beatMoments, toleranceSec) {
  return peakOutputSecs.filter(
    (peakSec) => hasBeatNearSec(beatMoments, peakSec, toleranceSec),
  );
}

function resolveMaxRetentionBeatMoments(recipe, profile, outputKind = "main") {
  const durationSec = outputKind === "short"
    ? resolveShortOutputDurationSec({
      outputs: recipe?.outputs ?? [],
      batchContext: recipe?.batchContext ?? {},
    })
    : resolveMainOutputDurationSec({
      outputs: recipe?.outputs ?? [],
      batchContext: recipe?.batchContext ?? {},
    });
  const defaults = outputKind === "short"
    ? DEFAULT_SHORTS_RETENTION_PROFILE
    : DEFAULT_VLOG_RETENTION_PROFILE;
  const mergedProfile = { ...defaults, ...profile };
  return computeScaledMinRetentionBeats(durationSec, mergedProfile);
}

function countEnrichBeatMoments(moments) {
  let maxIndex = 0;
  for (const moment of moments) {
    const match = /^enrich_beat_(\d+)$/.exec(moment.momentId ?? "");
    if (match) {
      maxIndex = Math.max(maxIndex, Number(match[1]));
    }
  }
  return maxIndex;
}
function collectTextOverlaysFromOutput(output) {
  const overlays = [];
  for (const segment of output?.timeline ?? []) {
    const segmentStart = segment.outputStartSec ?? 0;
    for (const overlay of segment.textOverlays ?? []) {
      overlays.push({
        ...overlay,
        outputStartSec: overlay.outputStartSec ?? segmentStart,
      });
    }
  }
  return overlays;
}

function isHookOverlayInWindow(overlay, hookWindowSec) {
  const startSec = overlay.outputStartSec ?? 0;
  if (startSec >= hookWindowSec) {
    return false;
  }
  if (overlay.role === "hook") {
    return true;
  }
  return isLargeHookOverlay(overlay);
}

function hasHookMomentInWindow(moments, outputId, hookWindowSec, textOverlays = []) {
  if (moments.some(
    (moment) => moment.outputId === outputId
      && moment.outputStartSec < hookWindowSec
      && isHookMoment(moment),
  )) {
    return true;
  }
  return textOverlays.some((overlay) => isHookOverlayInWindow(overlay, hookWindowSec));
}

function sceneUsedInTimeline(timeline, sceneId) {
  return (timeline ?? []).some(
    (segment) => segment.videoRef?.sceneId === sceneId
      || segment.audioRef?.sceneId === sceneId,
  );
}

function isHookSceneAtTimelineStart(shortOutput, hookSceneId) {
  const first = shortOutput?.timeline?.[0];
  if (!first) {
    return false;
  }
  if (first.segmentId === SHORT_HOOK_SEGMENT_ID) {
    return true;
  }
  if (!hookSceneId) {
    return true;
  }
  return first.videoRef?.sceneId === hookSceneId
    || first.audioRef?.sceneId === hookSceneId;
}

function resolveColdOpenHookSceneId(abstraction) {
  const loops = abstraction?.L3?.openLoops ?? [];
  const coldOpen = loops.find((loop) => loop.kind === "cold_open");
  if (!coldOpen) {
    return null;
  }
  return coldOpen.payoffSceneId ?? coldOpen.setupSceneId ?? null;
}

/**
 * True when prepending hook scene would spoil cold_open / payoff_tease open loops.
 */
export function wouldHookSpoilColdOpenLoops(hookSceneId, abstraction) {
  if (!hookSceneId) {
    return false;
  }

  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.kind !== "cold_open" && loop.kind !== "payoff_tease") {
      continue;
    }
    if (hookSceneId === loop.payoffSceneId || hookSceneId === loop.setupSceneId) {
      return true;
    }
  }

  return false;
}

function resolveKeyMomentsHookSceneId(abstraction) {
  let bestSceneId = null;
  let bestBroll = -1;

  for (const l1 of abstraction?.L1 ?? []) {
    if (!l1.keyMoments?.length) {
      continue;
    }
    const broll = l1.brollPotential ?? 0;
    if (broll > bestBroll) {
      bestBroll = broll;
      bestSceneId = l1.sceneId;
    }
  }

  return bestBroll >= 0.5 ? bestSceneId : null;
}

function resolveEnergyHookSceneId(timelineIndex, audioIndex) {
  let bestSceneId = null;
  let bestRms = -Infinity;

  for (const clip of audioIndex?.clips ?? []) {
    for (const peak of clip.energyPeaks ?? []) {
      const mid = (peak.startSec + peak.endSec) / 2;
      const scene = (timelineIndex?.scenes ?? []).find(
        (entry) => entry.clipId === clip.clipId
          && mid >= (entry.startSec ?? 0)
          && mid < (entry.endSec ?? entry.startSec + (entry.durationSec ?? 0)),
      );
      if (!scene) {
        continue;
      }
      const rms = peak.rmsDb ?? 0;
      if (rms > bestRms) {
        bestRms = rms;
        bestSceneId = scene.sceneId;
      }
    }
  }

  return bestSceneId;
}

function resolveRankedHookSceneId(abstraction, timelineIndex, audioIndex) {
  const ranks = buildTopSceneRanks(abstraction, timelineIndex, audioIndex, { limit: 5 });
  const wordIndex = { words: timelineIndex?.words ?? [] };

  for (const entry of ranks) {
    if (isSetupNarrativeScene(entry.sceneId, abstraction)) {
      continue;
    }
    const scene = (timelineIndex?.scenes ?? []).find((s) => s.sceneId === entry.sceneId);
    if (
      scene
      && isChronologicalFirstScene(entry.sceneId, timelineIndex)
      && segmentOpensWithGreeting(wordIndex, scene.startSec ?? 0)
    ) {
      continue;
    }
    return entry.sceneId;
  }
  return null;
}

/**
 * Resolve best hook scene for shorts — cold_open loop, then scene ranks / keyMoments / energy.
 * @param {object} abstraction
 * @param {object} timelineIndex
 * @param {object} [audioIndex]
 * @returns {{ sceneId: string|null, source: string }}
 */
export function resolveBestHookScene(abstraction, timelineIndex, audioIndex) {
  const coldOpenSceneId = resolveColdOpenHookSceneId(abstraction);
  if (coldOpenSceneId) {
    return { sceneId: coldOpenSceneId, source: "cold_open_loop" };
  }

  const rankedSceneId = resolveRankedHookSceneId(abstraction, timelineIndex, audioIndex)
    ?? resolveKeyMomentsHookSceneId(abstraction)
    ?? resolveEnergyHookSceneId(timelineIndex, audioIndex);
  if (rankedSceneId) {
    return { sceneId: rankedSceneId, source: "scene_rank" };
  }

  return { sceneId: null, source: "timeline_start" };
}

/**
 * Prepend non-chronological hook tease segment on short output (mirrors cold-open prepend).
 * @returns {boolean} whether a segment was prepended
 */
export function prependShortHookSegment(
  shortOutput,
  hookSceneId,
  timelineIndex,
  { allowBrollReuse = false, wordIndexes = null } = {},
) {
  if (!hookSceneId || !shortOutput?.timeline?.length) {
    return false;
  }

  if (isHookSceneAtTimelineStart(shortOutput, hookSceneId)) {
    return false;
  }

  if (!allowBrollReuse && sceneUsedInTimeline(shortOutput.timeline, hookSceneId)) {
    return false;
  }

  const scene = (timelineIndex?.scenes ?? []).find(
    (entry) => entry.sceneId === hookSceneId,
  );
  if (!scene) {
    return false;
  }

  const clipId = deriveClipIdFromSceneId(hookSceneId);
  const sceneEnd = scene.endSec ?? (scene.startSec ?? 0) + (scene.durationSec ?? DEFAULT_SHORT_HOOK_MAX_SEC);
  const sceneStart = scene.startSec ?? 0;
  const duration = Math.min(DEFAULT_SHORT_HOOK_MAX_SEC, sceneEnd - sceneStart);

  const wordIndex = wordIndexes?.find((entry) => entry.clipId === clipId) ?? null;
  const hookInpoint = wordIndex
    ? resolveHookWordInpointSec(wordIndex, sceneStart, sceneEnd)
    : Math.max(sceneStart, sceneEnd - duration);
  const videoInSec = Math.max(sceneStart, Math.min(hookInpoint, sceneEnd - 0.5));
  const videoOutSec = Math.min(sceneEnd, videoInSec + duration);

  shortOutput.timeline.unshift({
    segmentId: SHORT_HOOK_SEGMENT_ID,
    segmentRole: "aroll",
    videoRef: { clipId, sceneId: hookSceneId },
    audioRef: { clipId, sceneId: hookSceneId },
    videoInSec,
    videoOutSec,
    audioInSec: videoInSec,
    audioOutSec: videoOutSec,
    audioPolicy: "from_video_ref",
    overlapSec: 0,
    cuts: [],
    textOverlays: [],
  });

  return true;
}

/**
 * Add hook creativeMoment when shorts profile requires one and director omitted it.
 * Prepends best-scene tease when hook scene is not already at timeline start.
 * @param {object} shortOutput
 * @param {object} profile
 * @param {object[]} existingMoments
 * @param {{ abstraction?: object, timelineIndex?: object, audioIndex?: object, recipe?: object }} [options]
 * @returns {object[]}
 */
function enrichShortHookMoment(shortOutput, profile, existingMoments, options = {}) {
  if (!profile?.enabled || !profile.requireHookMoment) {
    return [];
  }

  const hookWindowSec = profile.hookWindowSec ?? DEFAULT_SHORTS_RETENTION_PROFILE.hookWindowSec;
  const textOverlays = collectTextOverlaysFromOutput(shortOutput);
  if (existingMoments.some((moment) => moment.momentId === "enrich_hook_001")) {
    return [];
  }
  if (hasHookMomentInWindow(
    existingMoments,
    shortOutput.outputId,
    hookWindowSec,
    textOverlays,
  )) {
    return [];
  }

  const { abstraction, timelineIndex, audioIndex, recipe, wordIndexes } = options;
  const allowBrollReuse = recipe?.batchContext?.allowBrollReuse ?? false;
  const { sceneId: hookSceneId, source: hookSource } = resolveBestHookScene(
    abstraction ?? {},
    timelineIndex ?? {},
    audioIndex,
  );

  let prepended = false;
  if (hookSceneId && !wouldHookSpoilColdOpenLoops(hookSceneId, abstraction ?? {})) {
    prepended = prependShortHookSegment(
      shortOutput,
      hookSceneId,
      timelineIndex,
      { allowBrollReuse, wordIndexes },
    );
  }

  const useTitleOverlay = profile.requireHookOverlay !== false;
  const techniqueId = useTitleOverlay ? "hook_title_overlay" : "hook_visual_punch";
  const durationSec = useTitleOverlay ? 2.5 : 0.8;
  const outputEndSec = Math.min(durationSec, hookWindowSec);

  const reason = prepended
    ? `Enriched non-chronological hook from ${hookSource} scene ${hookSceneId}`
    : hookSceneId && hookSource !== "timeline_start"
      ? `Enriched hook at best scene ${hookSceneId} (${hookSource})`
      : "Enriched hook moment in opening window";

  return [{
    momentId: "enrich_hook_001",
    techniqueId,
    outputId: shortOutput.outputId,
    outputStartSec: 0,
    outputEndSec: Math.round(outputEndSec * 10) / 10,
    retentionRole: "hook",
    params: useTitleOverlay ? { style: "hook_large" } : {},
    reason,
    confidence: 0.65,
  }];
}

/**
 * Merge retention beat creativeMoments for one output when director omitted beats near anchors.
 * @param {object} recipe
 * @param {object} targetOutput
 * @param {object} profile
 * @param {"vlog"|"shorts"} mode
 * @param {object[]} existingMoments
 * @param {{ audioIndex?: object, abstraction?: object, timelineIndex?: object, spatialIndex?: object }} options
 * @returns {object[]}
 */
function countRetentionBeatsInL2Segment(
  moments,
  l2SegmentId,
  abstraction,
  recipe,
  targetOutput,
  wordIndexes,
  { enrichOnly = false } = {},
) {
  const range = resolveL2OutputRangeSec(
    l2SegmentId,
    abstraction,
    recipe,
    targetOutput,
    wordIndexes,
  );
  if (!range) {
    return 0;
  }

  return moments.filter((moment) => {
    if (!isRetentionBeatMoment(moment)) {
      return false;
    }
    if (enrichOnly && !(moment.momentId ?? "").startsWith("enrich_beat_")) {
      return false;
    }
    const start = moment.outputStartSec ?? 0;
    return start >= range.startSec && start <= range.endSec;
  }).length;
}

function resolveAnchorL2SegmentId(anchor, abstraction, timelineIndex, targetOutput) {
  let clipId = anchor.clipId;
  let sourceTimeSec = anchor.timeSec ?? anchor.anchorTimeSec;

  if ((!clipId || !Number.isFinite(sourceTimeSec)) && Number.isFinite(anchor.outputSec)) {
    const resolved = resolveSegmentAtOutputSec(targetOutput, anchor.outputSec);
    if (resolved) {
      clipId = resolveSegmentClipId(resolved.segment);
      sourceTimeSec = resolved.sourceTimeSec;
    }
  }

  return findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    clipId,
    sourceTimeSec,
  );
}

function shouldSkipBeatEnrichForAnchor(
  anchor,
  recipe,
  abstraction,
  timelineIndex,
  targetOutput,
  { coverageMoments = [], wordIndexes } = {},
) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const l2SegmentId = resolveAnchorL2SegmentId(anchor, abstraction, timelineIndex, targetOutput);

  if (l2SegmentId && !shouldAllowRetentionEnrichForL2(narrativeProfile, l2SegmentId)) {
    return true;
  }

  const caps = resolveSegmentCaps(narrativeProfile, l2SegmentId, abstraction);
  if (caps) {
    if (caps.maxEnrichBeats === 0) {
      return true;
    }
    const enrichCount = countRetentionBeatsInL2Segment(
      coverageMoments,
      l2SegmentId,
      abstraction,
      recipe,
      targetOutput,
      wordIndexes,
      { enrichOnly: true },
    );
    if (enrichCount >= caps.maxEnrichBeats) {
      return true;
    }
    const totalCount = countRetentionBeatsInL2Segment(
      coverageMoments,
      l2SegmentId,
      abstraction,
      recipe,
      targetOutput,
      wordIndexes,
      { enrichOnly: false },
    );
    return totalCount >= caps.maxRetentionBeats;
  }

  if (!narrativeProfile?.segments?.length) {
    return false;
  }

  const segmentProfile = resolveL2SegmentProfile(narrativeProfile, l2SegmentId);
  return shouldSkipRetentionBeatEnrich(segmentProfile);
}

function enrichRetentionBeatsForOutput(
  recipe,
  targetOutput,
  profile,
  mode,
  existingMoments,
  {
    audioIndex,
    abstraction,
    timelineIndex,
    spatialIndex,
    wordIndexes,
  },
) {
  const outputKind = mode === "shorts" ? "short" : "main";
  const defaults = resolveRetentionDefaults(mode);
  const outputMoments = existingMoments.filter((moment) => moment.outputId === targetOutput.outputId);
  const enrichBeatMoments = outputMoments.filter(
    (moment) => (moment.momentId ?? "").startsWith("enrich_beat_"),
  );
  const existingEnrichBeatCount = enrichBeatMoments.length;
  const beatMoments = outputMoments.filter((moment) => isRetentionBeatMoment(moment));
  const directorBeatCount = beatMoments.filter(
    (moment) => !(moment.momentId ?? "").startsWith("enrich_beat_"),
  ).length;
  const existingBeatCount = beatMoments.length;
  const maxBeats = resolveMaxRetentionBeatMoments(recipe, profile, outputKind);

  // Fill up to the scaled min retention beat count (same as V22-VLOG-01 / shorts min).
  if (directorBeatCount === 0 && existingEnrichBeatCount >= maxBeats) {
    return [];
  }

  const slots = directorBeatCount === 0
    ? maxBeats - existingEnrichBeatCount
    : Math.max(0, maxBeats - existingBeatCount);
  const effectiveSlots = Math.max(0, slots);

  if (!audioIndex?.clips?.length || effectiveSlots === 0) {
    return [];
  }

  const durationSec = outputKind === "short"
    ? resolveShortOutputDurationSec({
      outputs: recipe.outputs ?? [],
      batchContext: recipe.batchContext ?? {},
    })
    : resolveMainOutputDurationSec({
      outputs: recipe.outputs ?? [],
      batchContext: recipe.batchContext ?? {},
    });

  const anchors = buildRetentionBeatAnchors(
    audioIndex,
    abstraction ?? {},
    profile,
    {
      timelineIndex,
      durationSec,
      mode,
      recipe,
      outputKind,
      wordIndexes,
    },
  );
  const toleranceSec = profile.retentionBeatToleranceSec ?? defaults.retentionBeatToleranceSec;
  const mapContext = { recipe, outputKind, wordIndexes };
  const energyPeakOutputSecs = collectEnergyPeakOutputSecs(audioIndex, mapContext);
  let cooldownPeakSecs = peaksWithNearbyBeats(
    energyPeakOutputSecs,
    beatMoments,
    toleranceSec,
  );

  const newMoments = [];
  let enrichIndex = countEnrichBeatMoments(existingMoments);
  const coverageMoments = [...beatMoments, ...enrichBeatMoments];

  for (const anchor of anchors) {
    if (newMoments.length >= effectiveSlots) {
      break;
    }

    if (isInPeakCooldown(anchor.outputSec, cooldownPeakSecs, ENRICH_PEAK_COOLDOWN_SEC)) {
      continue;
    }

    const covered = hasBeatNearSec(coverageMoments, anchor.idealOutputSec, toleranceSec)
      || hasBeatNearSec(coverageMoments, anchor.outputSec, toleranceSec)
      || hasBeatNearSec(newMoments, anchor.outputSec, toleranceSec);

    if (covered) {
      continue;
    }

    if (shouldSkipBeatEnrichForAnchor(anchor, recipe, abstraction, timelineIndex, targetOutput, {
      coverageMoments: [...coverageMoments, ...newMoments],
      wordIndexes,
    })) {
      continue;
    }

    const techniqueId = resolveEnrichBeatTechniqueId(
      anchor.suggestedTechniqueId,
      recipe?.creativityProfile?.level,
    );
    if (techniqueId === "pattern_interrupt") {
      const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
      const l2SegmentId = resolveAnchorL2SegmentId(
        anchor,
        abstraction,
        timelineIndex,
        targetOutput,
      );
      const caps = resolveSegmentCaps(narrativeProfile, l2SegmentId, abstraction);
      if (caps && !caps.allowPatternInterrupt) {
        continue;
      }
    }

    const beatDurationSec = enrichBeatDurationSec(enrichIndex);
    const outputStartSec = anchor.outputSec;
    enrichIndex += 1;

    const spatialRef = resolveSpatialRefForBeat({
      spatialIndex,
      timelineIndex,
      outputStartSec,
      mainOutput: targetOutput,
      techniqueId,
    });

    newMoments.push({
      momentId: `enrich_beat_${String(enrichIndex).padStart(3, "0")}`,
      techniqueId,
      outputId: targetOutput.outputId,
      outputStartSec,
      outputEndSec: Math.round((outputStartSec + beatDurationSec) * 10) / 10,
      retentionRole: "beat",
      params: {},
      ...(spatialRef ? { spatialRef } : {}),
      reason: anchor.label
        ? `Enriched retention beat near «${anchor.label}» (${anchor.anchorSource})`
        : `Enriched retention beat at ${outputStartSec}s (${anchor.anchorSource})`,
      confidence: 0.65,
    });

    const placedPeakSec = findEnergyPeakNearOutputSec(
      energyPeakOutputSecs,
      outputStartSec,
      toleranceSec,
    );
    if (placedPeakSec != null && !cooldownPeakSecs.includes(placedPeakSec)) {
      cooldownPeakSecs.push(placedPeakSec);
    }
  }

  return newMoments;
}

/**
 * Merge retention beat creativeMoments into recipe when director omitted beats near anchors.
 * Preserves existing director moments; when director placed zero beats, fills up to scaled min.
 * When director placed some beats, caps new beats at maxRetentionBeatMoments − existingBeatCount.
 * Enriches vlog main (vlogRetentionProfile) and shorts (shortsRetentionProfile).
 *
 * @param {object} recipe - EditRecipe v2 draft
 * @param {{ audioIndex?: object, abstraction?: object, timelineIndex?: object, spatialIndex?: object }} [options]
 * @returns {object[]} merged creativeMoments
 */
export function enrichRecipeRetentionBeats(recipe, {
  audioIndex,
  abstraction,
  timelineIndex,
  spatialIndex,
  wordIndexes,
} = {}) {
  const creativityLevel = recipe?.creativityProfile?.level ?? "balanced";
  let moments = (recipe?.creativeMoments ?? []).map((moment) => {
    if (!(moment.momentId ?? "").startsWith("enrich_beat_")) {
      return moment;
    }
    const techniqueId = resolveEnrichBeatTechniqueId(moment.techniqueId, creativityLevel);
    return techniqueId === moment.techniqueId
      ? moment
      : { ...moment, techniqueId };
  });
  const outputs = recipe?.outputs ?? [];
  const enrichOptions = { audioIndex, abstraction, timelineIndex, spatialIndex, wordIndexes, recipe };

  const mainOutput = outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  const vlogProfile = recipe?.vlogRetentionProfile ?? {};
  if (mainOutput && vlogProfile.enabled) {
    moments = [
      ...moments,
      ...enrichRetentionBeatsForOutput(
        recipe,
        mainOutput,
        vlogProfile,
        "vlog",
        moments,
        enrichOptions,
      ),
    ];
  }

  const shortOutput = outputs.find(
    (output) => output.outputKind === "short" || output.format === "9:16",
  );
  const shortsProfile = recipe?.shortsRetentionProfile ?? {};
  if (shortOutput && shortsProfile.enabled) {
    moments = [
      ...moments,
      ...enrichShortHookMoment(shortOutput, shortsProfile, moments, enrichOptions),
    ];
    moments = [
      ...moments,
      ...enrichRetentionBeatsForOutput(
        recipe,
        shortOutput,
        shortsProfile,
        "shorts",
        moments,
        enrichOptions,
      ),
    ];
  }

  return moments;
}

function collectSlowBreathL2OutputRanges(recipe, mainOutput, abstraction, wordIndexes) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  const ranges = [];
  const seen = new Set();

  for (const l2Segment of abstraction?.L2 ?? []) {
    const segmentProfile = narrativeProfile
      ? resolveL2SegmentProfile(narrativeProfile, l2Segment.segmentId)
      : null;
    if (!isSlowBreathNarrativeSegment(segmentProfile, l2Segment)) {
      continue;
    }
    if (seen.has(l2Segment.segmentId)) {
      continue;
    }
    const range = resolveL2OutputRangeSec(
      l2Segment.segmentId,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (range) {
      ranges.push(range);
      seen.add(l2Segment.segmentId);
    }
  }

  return ranges;
}

function isEnrichBeatInSlowBreathRange(moment, outputId, ranges) {
  if (!(moment.momentId ?? "").startsWith("enrich_beat_")) {
    return false;
  }
  if (moment.outputId !== outputId) {
    return false;
  }
  const sec = moment.outputStartSec ?? 0;
  return ranges.some((range) => sec >= range.startSec && sec < range.endSec);
}

/**
 * Remove enrich_beat_* creativeMoments that fall inside slow/breath L2 output ranges.
 * Run before retention enrich so slow sections stay clean.
 *
 * @param {object} recipe
 * @param {object} [abstraction]
 * @param {{ wordIndexes?: object[] }} [options]
 * @returns {object[]} filtered creativeMoments
 */
export function stripEnrichBeatsInSlowSegments(recipe, abstraction, { wordIndexes = null } = {}) {
  const moments = recipe?.creativeMoments ?? [];
  if (!moments.length || !abstraction?.L2?.length) {
    return moments;
  }

  const mainOutput = (recipe.outputs ?? []).find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
  if (!mainOutput) {
    return moments;
  }

  const slowBreathRanges = collectSlowBreathL2OutputRanges(
    recipe,
    mainOutput,
    abstraction,
    wordIndexes,
  );
  if (!slowBreathRanges.length) {
    return moments;
  }

  const filtered = moments.filter(
    (moment) => !isEnrichBeatInSlowBreathRange(moment, mainOutput.outputId, slowBreathRanges),
  );

  if (filtered.length !== moments.length) {
    recipe.creativeMoments = filtered;
  }

  return filtered;
}

/**
 * Snap ideal retention beat positions to nearest energyPeaks or L1 keyMoments.
 * Brief-only — does not mutate the recipe.
 * @param {object} audioIndex
 * @param {object} abstraction
 * @param {object} profile
 * @param {{ timelineIndex?: object, durationSec?: number, mode?: "vlog"|"shorts", recipe?: object, outputs?: object[], outputKind?: "main"|"short", wordIndexes?: object[] }} [options]
 */
export function buildRetentionBeatAnchors(audioIndex, abstraction, profile = {}, options = {}) {
  if (!profile?.enabled) {
    return [];
  }

  const mode = profile.mode ?? options.mode ?? "vlog";
  const defaults = resolveRetentionDefaults(mode);
  const toleranceSec = profile.retentionBeatToleranceSec ?? defaults.retentionBeatToleranceSec;
  const durationSec = options.durationSec ?? 600;
  const targets = computeRetentionBeatTargets(durationSec, profile, { mode });
  const rotation = buildRetentionTechniqueRotation(targets.length, mode);
  const outputKind = options.outputKind ?? (mode === "shorts" ? "short" : "main");
  const candidates = collectRetentionAnchorCandidates(
    audioIndex,
    abstraction,
    options.timelineIndex,
    {
      recipe: options.recipe,
      outputs: options.outputs,
      outputKind,
      wordIndexes: options.wordIndexes,
    },
  );

  const usedCandidates = new Set();

  return targets.map((idealOutputSec, index) => {
    const nearest = findNearestAnchor(candidates, idealOutputSec, toleranceSec, usedCandidates);
    if (nearest) {
      usedCandidates.add(nearest);
    }
    const outputSec = nearest?.outputSec ?? idealOutputSec;

    return {
      idealOutputSec,
      outputSec,
      clipId: nearest?.clipId,
      anchorTimeSec: nearest?.timeSec,
      anchorSource: nearest?.source ?? "cadence",
      label: nearest?.label,
      toleranceSec,
      suggestedTechniqueId: rotation[index % rotation.length],
      retentionRole: "beat",
    };
  });
}
