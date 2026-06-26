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
};

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
  if (hasShortOutput(outputs) || isShortOnlyFormatRequired(requiredFormats)) {
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
 * @param {number} durationSec
 * @param {object} profile
 */
export function computeScaledMinRetentionBeats(durationSec, profile) {
  const base = profile.minRetentionBeats ?? DEFAULT_SHORTS_RETENTION_PROFILE.minRetentionBeats;
  const interval = profile.retentionBeatIntervalSec
    ?? DEFAULT_SHORTS_RETENTION_PROFILE.retentionBeatIntervalSec;

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
 * Idealne pozycje beatów (po hook window) do briefu directora.
 * Gwarantuje co najmniej minRetentionBeats pozycji w obrębie durationSec.
 * @param {number} durationSec
 * @param {object} profile
 */
export function computeRetentionBeatTargets(durationSec, profile) {
  const hookWindow = profile.hookWindowSec ?? DEFAULT_SHORTS_RETENTION_PROFILE.hookWindowSec;
  const interval = profile.retentionBeatIntervalSec
    ?? DEFAULT_SHORTS_RETENTION_PROFILE.retentionBeatIntervalSec;
  const minBeats = computeScaledMinRetentionBeats(durationSec, profile);
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
 */
export function formatRetentionGrammarForPrompt(profile, beatTargets = []) {
  if (!profile?.enabled) {
    return null;
  }

  const beats = beatTargets.length
    ? beatTargets.map((sec) => `${sec}s`).join(", ")
    : `co ${profile.retentionBeatIntervalSec}s (±${profile.retentionBeatToleranceSec}s)`;

  return {
    hookWindowSec: profile.hookWindowSec,
    rules: [
      `0–${profile.hookWindowSec}s: hook — najlepszy moment (nie chronologia), tekst + wizualny punch`,
      `Retention beats: ${beats}`,
      `Min beats: ${profile.minRetentionBeats} (skalowane dla >30s)`,
      `Overlay budget: max 1 duży napis na ${LARGE_HOOK_OVERLAY_BUDGET_WINDOW_SEC}s`,
      `retentionRole: hook | beat | payoff na creativeMoments; role cta na textOverlays (call-to-action, nie kulminacja)`,
      `textOverlays: style hook_large | hook_question | hook_number | emphasis | chapter_card; role hook | retention_beat | cta`,
    ],
    requireHookMoment: profile.requireHookMoment,
    requireHookOverlay: profile.requireHookOverlay,
    techniquePack: profile.techniquePack,
  };
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
