import {
  isSlowBreathNarrativeSegment,
  resolveL2OutputRangeSec,
  resolveL2SegmentProfile,
  resolveRecipeNarrativeProfile,
} from "../lib/narrative-profile.js";

export const ACT_TRANSITION_TOLERANCE_SEC = 30;
export const MAX_ACT_TRANSITIONS_PER_MAIN = 2;

const ACT_TRANSITION_ROLE_PAIRS = [
  { from: "setup", to: "tension" },
  { from: "climax", to: "resolution" },
];

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function isActTransitionPair(prevRole, nextRole) {
  return ACT_TRANSITION_ROLE_PAIRS.some(
    (pair) => pair.from === prevRole && pair.to === nextRole,
  );
}

function hasDipToBlackNear(moments, outputId, targetSec, toleranceSec) {
  return moments.some(
    (moment) => moment.outputId === outputId
      && moment.techniqueId === "dip_to_black"
      && Math.abs((moment.outputStartSec ?? 0) - targetSec) <= toleranceSec,
  );
}

function resolveTransitionTargetSec(l2Segment, abstraction, recipe, mainOutput, wordIndexes) {
  const range = mainOutput
    ? resolveL2OutputRangeSec(l2Segment.segmentId, abstraction, recipe, mainOutput, wordIndexes)
    : null;
  if (range?.startSec != null) {
    return Math.round(range.startSec * 10) / 10;
  }
  if (l2Segment.startSec != null) {
    return Math.round(l2Segment.startSec * 10) / 10;
  }
  return null;
}

/**
 * Brief-only hints for dip_to_black at L2 act boundaries (setup→tension, climax→resolution).
 *
 * @param {object} abstraction
 * @param {object} [narrativeProfile]
 * @param {{ recipe?: object, wordIndexes?: object[] }} [options]
 */
export function buildActTransitionHints(abstraction, narrativeProfile = null, options = {}) {
  void narrativeProfile;

  const l2Segments = abstraction?.L2 ?? [];
  if (l2Segments.length < 2) {
    return [];
  }

  const { recipe = {}, wordIndexes = null } = options;
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  const hints = [];

  for (let i = 1; i < l2Segments.length; i++) {
    const prev = l2Segments[i - 1];
    const curr = l2Segments[i];
    if (!isActTransitionPair(prev.narrativeRole, curr.narrativeRole)) {
      continue;
    }

    const targetSec = resolveTransitionTargetSec(
      curr,
      abstraction,
      recipe,
      mainOutput,
      wordIndexes,
    );
    if (targetSec == null) {
      continue;
    }

    hints.push({
      outputId: mainOutput?.outputId ?? "main_16x9",
      targetSec,
      techniqueId: "dip_to_black",
      fromRole: prev.narrativeRole,
      toRole: curr.narrativeRole,
      l2SegmentId: curr.segmentId,
      suggestion:
        `Ok. ${Math.round(targetSec)}s — dip_to_black przy przejściu `
        + `${prev.narrativeRole}→${curr.narrativeRole}`,
    });
  }

  return hints.slice(0, MAX_ACT_TRANSITIONS_PER_MAIN);
}

/**
 * Add dip_to_black creativeMoments at act boundaries when director omitted them (±30s).
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {{ abstraction?: object, narrativeProfile?: object, wordIndexes?: object[] }} [options]
 * @returns {object[]} merged creativeMoments
 */
export function enrichRecipeActTransitions(recipe, {
  abstraction,
  narrativeProfile = null,
  wordIndexes = null,
} = {}) {
  const moments = [...(recipe?.creativeMoments ?? [])];
  const mainOutput = findMainOutput(recipe?.outputs ?? []);
  if (!mainOutput || !abstraction?.L2?.length) {
    return moments;
  }

  const effectiveProfile = narrativeProfile ?? resolveRecipeNarrativeProfile(recipe);
  const hints = buildActTransitionHints(abstraction, effectiveProfile, {
    recipe,
    wordIndexes,
  });
  if (!hints.length) {
    return moments;
  }

  const existingDipCount = moments.filter(
    (moment) => moment.outputId === mainOutput.outputId
      && moment.techniqueId === "dip_to_black",
  ).length;
  const slots = Math.max(0, MAX_ACT_TRANSITIONS_PER_MAIN - existingDipCount);
  if (slots === 0) {
    return moments;
  }

  const newMoments = [];
  let enrichIndex = moments.filter((m) => (m.momentId ?? "").startsWith("enrich_act_dip_")).length;

  for (const hint of hints) {
    if (newMoments.length >= slots) {
      break;
    }

    if (hasDipToBlackNear(
      [...moments, ...newMoments],
      hint.outputId,
      hint.targetSec,
      ACT_TRANSITION_TOLERANCE_SEC,
    )) {
      continue;
    }

    enrichIndex += 1;
    const outputStartSec = hint.targetSec;
    newMoments.push({
      momentId: `enrich_act_dip_${String(enrichIndex).padStart(3, "0")}`,
      techniqueId: "dip_to_black",
      outputId: mainOutput.outputId,
      outputStartSec,
      outputEndSec: Math.round((outputStartSec + 0.8) * 10) / 10,
      params: { durationSec: 0.6 },
      reason: hint.suggestion,
      confidence: 0.7,
    });
  }

  if (!newMoments.length) {
    return moments;
  }

  recipe.creativeMoments = [...moments, ...newMoments];
  return recipe.creativeMoments;
}

export {
  isActTransitionPair,
  hasDipToBlackNear,
};
