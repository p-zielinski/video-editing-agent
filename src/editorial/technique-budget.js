import {
  computeScaledMinRetentionBeats,
  DEFAULT_VLOG_RETENTION_PROFILE,
} from "./shorts-retention.js";

export const CREATIVITY_LEVELS = ["safe", "balanced", "bold", "shorts"];

export const CREATIVITY_LEVEL_ORDER = {
  safe: 0,
  balanced: 1,
  bold: 2,
  shorts: 3,
};

/** Techniques allowed at `safe` creativity level (zoom budget still applies). */
export const SAFE_ALLOWED_TECHNIQUE_IDS = new Set([
  "cut_on_beat",
  "crossfade",
  "zoom_punch_in",
  "zoom_punch_out",
  "zoom_slow_push",
]);

export const DEFAULT_CREATIVITY_PROFILE = {
  level: "balanced",
  allowMidSentenceCuts: false,
  techniquePack: "youtube_vlog_2026",
  maxTechniqueDensityPerMin: 0.3,
};

const LEVEL_MULTIPLIERS = {
  safe: { zoom: 0.5, density: 0.5, minGap: 1.5 },
  balanced: { zoom: 1.0, density: 1.0, minGap: 1.0 },
  bold: { zoom: 1.4, density: 1.3, minGap: 0.85 },
  shorts: { zoom: 2.0, density: 2.0, minGap: 0.5 },
};

const CAMERA_ZOOM_IDS = new Set([
  "zoom_punch_in",
  "zoom_punch_out",
  "zoom_slow_push",
  "snap_zoom",
]);

/**
 * @param {string} currentLevel
 * @param {string} requiredLevel
 */
export function meetsCreativityLevel(currentLevel, requiredLevel) {
  const current = CREATIVITY_LEVEL_ORDER[currentLevel] ?? CREATIVITY_LEVEL_ORDER.balanced;
  const required = CREATIVITY_LEVEL_ORDER[requiredLevel] ?? 0;
  return current >= required;
}

/**
 * Port logiki z video-modifier/lib/visual-edit-tuning.js
 */
export function computeDurationTuning(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return computeDurationTuning(600);
  }

  const minutes = durationSec / 60;
  const maxZoomMoments = Math.min(9, Math.max(3, Math.ceil(minutes / 6)));
  const minZoomGapSec = Math.max(
    30,
    Math.min(150, durationSec / (maxZoomMoments + 2)),
  );
  const maxTotalZoomDutySec = durationSec * 0.018;

  return {
    durationSec,
    minutes,
    maxZoomMoments,
    minZoomGapSec,
    maxTotalZoomDutySec,
  };
}

export function parseCreativityFromContext(userContext = "") {
  const text = String(userContext).toLowerCase();
  const profile = { ...DEFAULT_CREATIVITY_PROFILE };

  const levelMatch = text.match(/creativity:\s*(safe|balanced|bold|shorts)/);
  if (levelMatch) {
    profile.level = levelMatch[1];
  }

  if (/shorts:\s*energy\s*high/.test(text)) {
    profile.level = "shorts";
    profile.techniquePack = "shorts_energy";
    profile.maxTechniqueDensityPerMin = 0.6;
  }

  if (profile.level === "bold" || profile.level === "shorts") {
    profile.allowMidSentenceCuts = true;
  }

  return profile;
}

/**
 * @param {object} overrides
 * @param {{ defaultCreativityLevel?: string }} [packDefaults]
 */
export function mergeCreativityProfile(overrides = {}, packDefaults = {}) {
  const level = overrides.level
    ?? packDefaults.defaultCreativityLevel
    ?? DEFAULT_CREATIVITY_PROFILE.level;

  const merged = {
    ...DEFAULT_CREATIVITY_PROFILE,
    ...overrides,
    level,
  };

  if ((level === "bold" || level === "shorts") && overrides.allowMidSentenceCuts !== false) {
    merged.allowMidSentenceCuts = true;
  }

  return merged;
}

/**
 * Camera techniques count toward zoom budget unless explicitly opted out.
 * @param {string} techniqueId
 * @param {{ byId?: Map<string, { category?: string, constraints?: object }> }} [catalog]
 */
export function countsTowardZoomBudget(techniqueId, catalog) {
  const technique = catalog?.byId?.get(techniqueId);
  if (!technique) {
    return CAMERA_ZOOM_IDS.has(techniqueId);
  }
  if (technique.constraints?.countsTowardZoomBudget === false) {
    return false;
  }
  if (technique.constraints?.countsTowardZoomBudget === true) {
    return true;
  }
  return technique.category === "camera";
}

/** @deprecated use countsTowardZoomBudget */
export function isCameraZoomTechnique(techniqueId, catalog) {
  return countsTowardZoomBudget(techniqueId, catalog);
}

/**
 * @param {number} durationSec
 * @param {import('../schemas/edit-recipe-v2.js').CreativityProfile} creativityProfile
 */
export function computeCreativityBudget(durationSec, creativityProfile = DEFAULT_CREATIVITY_PROFILE) {
  const tuning = computeDurationTuning(durationSec);
  const level = creativityProfile.level ?? "balanced";
  const mult = LEVEL_MULTIPLIERS[level] ?? LEVEL_MULTIPLIERS.balanced;

  const maxZoomMoments = Math.max(
    1,
    Math.round(tuning.maxZoomMoments * mult.zoom),
  );
  const minZoomGapSec = Math.round(tuning.minZoomGapSec * mult.minGap);
  const maxTotalZoomDutySec = tuning.maxTotalZoomDutySec * mult.density;
  const maxTechniqueDensityPerMin = creativityProfile.maxTechniqueDensityPerMin
    ?? DEFAULT_CREATIVITY_PROFILE.maxTechniqueDensityPerMin;
  const maxTotalTechniqueMoments = Math.max(
    1,
    Math.ceil(tuning.minutes * maxTechniqueDensityPerMin * mult.density),
  );

  return {
    ...tuning,
    level,
    allowMidSentenceCuts: Boolean(creativityProfile.allowMidSentenceCuts),
    techniquePack: creativityProfile.techniquePack ?? DEFAULT_CREATIVITY_PROFILE.techniquePack,
    maxZoomMoments,
    minZoomGapSec,
    maxTotalZoomDutySec,
    maxTechniqueDensityPerMin,
    maxTotalTechniqueMoments,
    safeAllowedTechniqueIds: SAFE_ALLOWED_TECHNIQUE_IDS,
    cameraZoomTechniqueIds: CAMERA_ZOOM_IDS,
  };
}

/**
 * @param {{ timeline?: object[], targetDurationSec?: number }} output
 */
export function estimateOutputDurationSec(output) {
  if (output?.targetDurationSec) {
    return output.targetDurationSec;
  }
  let maxSec = 0;
  for (const seg of output?.timeline ?? []) {
    const end = seg.outputEndSec
      ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
    maxSec = Math.max(maxSec, end);
  }
  return maxSec;
}

/**
 * Brief-safe subset of a creativity budget (director / critic payloads).
 * @param {ReturnType<typeof computeCreativityBudget>} budget
 */
export function summarizeCreativityBudgetForBrief(budget) {
  const summary = {
    level: budget.level,
    allowMidSentenceCuts: budget.allowMidSentenceCuts,
    maxZoomMoments: budget.maxZoomMoments,
    minZoomGapSec: budget.minZoomGapSec,
    maxTotalZoomDutySec: budget.maxTotalZoomDutySec,
    maxTotalTechniqueMoments: budget.maxTotalTechniqueMoments,
  };
  if (budget.maxRetentionBeatMoments != null) {
    summary.maxRetentionBeatMoments = budget.maxRetentionBeatMoments;
  }
  return summary;
}

function resolveOutputKind(output) {
  if (output.outputKind) {
    return output.outputKind;
  }
  return output.format === "9:16" ? "short" : "main";
}

function isMainOutput(output) {
  const kind = resolveOutputKind(output);
  return kind === "main" || output.format === "16:9";
}

/**
 * Placeholder outputs for budget planning before a recipe draft exists.
 * @param {{ outputs?: object[], requiredFormats?: string[], durationSec?: number, batchContext?: object }} params
 */
export function synthesizeOutputsForBudget({
  outputs = [],
  requiredFormats = [],
  durationSec = 600,
  batchContext = {},
} = {}) {
  if (outputs.length > 0) {
    return outputs;
  }

  const formats = requiredFormats.length > 0 ? requiredFormats : ["16:9"];
  return formats.map((format) => {
    const isShort = format === "9:16";
    const outputDuration = isShort
      ? (batchContext.shortsMaxDurationSec ?? 60)
      : durationSec;
    return {
      outputId: isShort ? "short_9x16" : "main_16x9",
      format,
      outputKind: isShort ? "short" : "main",
      targetDurationSec: outputDuration,
      timeline: [],
    };
  });
}

/**
 * Per-output creativity budgets. Main outputs get a separate retention beat pool
 * (`maxRetentionBeatMoments`) so vlog beats do not consume `maxTotalTechniqueMoments`.
 *
 * @param {{ outputs?: object[], vlogRetentionProfile?: object }} recipe
 * @param {import('../schemas/edit-recipe-v2.js').CreativityProfile} [creativityProfile]
 */
export function computeCreativityBudgetForRecipe(
  recipe,
  creativityProfile = DEFAULT_CREATIVITY_PROFILE,
) {
  const outputs = recipe?.outputs ?? [];
  const vlogProfile = recipe?.vlogRetentionProfile ?? DEFAULT_VLOG_RETENTION_PROFILE;
  const byOutputId = {};

  for (const output of outputs) {
    const durationSec = estimateOutputDurationSec(output) || 600;
    const outputKind = resolveOutputKind(output);
    const budget = {
      ...computeCreativityBudget(durationSec, creativityProfile),
      outputId: output.outputId,
      outputKind,
      durationSec,
    };

    if (isMainOutput(output)) {
      budget.maxRetentionBeatMoments = computeScaledMinRetentionBeats(
        durationSec,
        vlogProfile,
      );
    }

    byOutputId[output.outputId] = budget;
  }

  const mainOutput = outputs.find((output) => isMainOutput(output));
  const defaultOutput = mainOutput ?? outputs[0];
  const defaultBudget = defaultOutput
    ? byOutputId[defaultOutput.outputId]
    : computeCreativityBudget(600, creativityProfile);

  return { byOutputId, default: defaultBudget };
}
