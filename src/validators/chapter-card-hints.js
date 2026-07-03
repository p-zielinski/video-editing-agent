import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { resolveMainOutputDurationSec } from "../editorial/shorts-retention.js";

export const CHAPTER_CARD_MIN_DURATION_SEC = 180;
export const CHAPTER_CARD_NEAR_TOLERANCE_SEC = 15;
export const CHAPTER_CARD_VALIDATOR_CODE = "V26-CHAPTER-01";

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolveChapterCardHints(recipe, chapterCardHints) {
  if (chapterCardHints?.length) {
    return chapterCardHints;
  }
  return recipe?.chapterCardHints ?? [];
}

function resolveHintTargetSec(hint) {
  return hint.targetSec ?? hint.startSec;
}

function collectChapterCardOverlays(mainOutput, { wordIndexes } = {}) {
  const enrichedTimeline = buildOutputTimeline(mainOutput, { wordIndexes });
  const overlays = [];

  for (const segment of enrichedTimeline) {
    for (const overlay of segment.textOverlays ?? []) {
      if (overlay.style === "chapter_card") {
        overlays.push(overlay);
      }
    }
  }

  return overlays;
}

function hasChapterCardNear(overlays, targetSec, toleranceSec = CHAPTER_CARD_NEAR_TOLERANCE_SEC) {
  return overlays.some((overlay) => {
    const anchor = overlay.outputStartSec ?? 0;
    return Math.abs(anchor - targetSec) <= toleranceSec;
  });
}

/**
 * Warn when chapterCardHints exist but main output lacks matching chapter_card overlays.
 *
 * @param {object} recipe
 * @param {{
 *   chapterCardHints?: object[],
 *   wordIndexes?: object[],
 * }} [options]
 */
export function validateChapterCardHintCoverage(recipe, {
  chapterCardHints,
  wordIndexes,
} = {}) {
  const hints = resolveChapterCardHints(recipe, chapterCardHints);
  if (!hints.length) {
    return [];
  }

  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return [];
  }

  const durationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });
  if (durationSec < CHAPTER_CARD_MIN_DURATION_SEC) {
    return [];
  }

  const overlays = collectChapterCardOverlays(mainOutput, { wordIndexes });
  const issues = [];

  for (const hint of hints) {
    if (hint.outputId && hint.outputId !== mainOutput.outputId) {
      continue;
    }

    const targetSec = resolveHintTargetSec(hint);
    if (targetSec == null || !Number.isFinite(targetSec)) {
      continue;
    }

    if (hasChapterCardNear(overlays, targetSec)) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: CHAPTER_CARD_VALIDATOR_CODE,
      message: `Brak textOverlay style chapter_card w ±${CHAPTER_CARD_NEAR_TOLERANCE_SEC}s od hintu `
        + `(${Math.round(targetSec)}s) — director/enrich nie pokrył chapterCardHints`,
      outputId: mainOutput.outputId,
    });
  }

  return issues;
}
