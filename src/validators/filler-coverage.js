export const HIGH_FILLER_RATIO_THRESHOLD = 0.6;
export const FILLER_COVERAGE_VALIDATOR_CODE = "V26-FILLER-01";

export function computeSceneFillerRatio(sceneId, timelineIndex) {
  const sceneMeta = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  if (!sceneMeta) {
    return 0;
  }

  const words = (timelineIndex?.words ?? []).filter(
    (word) => word.start >= sceneMeta.startSec && word.start < sceneMeta.endSec,
  );
  if (words.length === 0) {
    return 0;
  }

  const fillerCount = words.filter((word) => word.isFiller).length;
  return fillerCount / words.length;
}

function collectSceneWordIds(sceneId, timelineIndex) {
  const sceneMeta = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  if (!sceneMeta) {
    return [];
  }

  return (timelineIndex?.words ?? [])
    .filter((word) => word.start >= sceneMeta.startSec && word.start < sceneMeta.endSec)
    .map((word) => word.wordId);
}

function collectCutWordIds(recipe) {
  const wordIds = new Set();
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      for (const cut of segment.cuts ?? []) {
        if (cut.startWordId) {
          wordIds.add(cut.startWordId);
        }
        if (cut.endWordId) {
          wordIds.add(cut.endWordId);
        }
      }
    }
  }
  return wordIds;
}

function sceneHasCutCoverage(sceneWordIds, cutWordIds) {
  return sceneWordIds.some((wordId) => cutWordIds.has(wordId));
}

/**
 * Warn when an L1 scene has high filler ratio but no timeline cuts reference its words.
 *
 * @param {object} recipe
 * @param {{ abstraction?: object, timelineIndex?: object }} [options]
 */
export function validateFillerCutCoverage(recipe, { abstraction, timelineIndex } = {}) {
  const l1Scenes = abstraction?.L1 ?? [];
  if (!l1Scenes.length || !timelineIndex?.words?.length) {
    return [];
  }

  const cutWordIds = collectCutWordIds(recipe);
  const issues = [];

  for (const scene of l1Scenes) {
    const fillerRatio = computeSceneFillerRatio(scene.sceneId, timelineIndex);
    if (fillerRatio <= HIGH_FILLER_RATIO_THRESHOLD) {
      continue;
    }

    const sceneWordIds = collectSceneWordIds(scene.sceneId, timelineIndex);
    if (sceneWordIds.length === 0) {
      continue;
    }

    if (sceneHasCutCoverage(sceneWordIds, cutWordIds)) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: FILLER_COVERAGE_VALIDATOR_CODE,
      message: `Scena ${scene.sceneId} ma wysoki filler ratio (${(fillerRatio * 100).toFixed(0)}%) `
        + "bez cuts[] odnoszących się do słów tej sceny",
      sceneId: scene.sceneId,
    });
  }

  return issues;
}
