import {
  bestHintBySceneId,
  DEFAULT_BROLL_SYNC_MIN_CONFIDENCE,
  DEFAULT_BROLL_SYNC_TOLERANCE_SEC,
} from "../editorial/broll-sync-hints.js";

/**
 * Warn when B-roll videoInSec diverges from high-confidence sync hints after enrich.
 *
 * @param {object} recipe
 * @param {{
 *   brollSyncHints?: object[],
 *   minConfidence?: number,
 *   toleranceSec?: number,
 * }} [options]
 */
export function validateBrollSyncHintAdherence(recipe, {
  brollSyncHints = [],
  minConfidence = DEFAULT_BROLL_SYNC_MIN_CONFIDENCE,
  toleranceSec = DEFAULT_BROLL_SYNC_TOLERANCE_SEC,
} = {}) {
  const issues = [];
  if (!brollSyncHints?.length) {
    return issues;
  }

  const hintsByScene = bestHintBySceneId(brollSyncHints);

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.segmentRole !== "broll") {
        continue;
      }

      const sceneId = segment.videoRef?.sceneId;
      if (!sceneId) {
        continue;
      }

      const hint = hintsByScene.get(sceneId);
      if (!hint || hint.confidence < minConfidence) {
        continue;
      }

      const currentIn = segment.videoInSec ?? 0;
      const delta = Math.abs(currentIn - hint.suggestedVideoInSec);
      if (delta <= toleranceSec) {
        continue;
      }

      issues.push({
        severity: "warning",
        code: "V25-BROLL-06",
        message: `B-roll ${sceneId}: videoInSec=${currentIn} poza sugestią sync `
          + `(${hint.suggestedVideoInSec}±${toleranceSec}s, confidence=${hint.confidence.toFixed(2)})`,
        outputId: output.outputId,
        sceneId,
      });
    }
  }

  return issues;
}
