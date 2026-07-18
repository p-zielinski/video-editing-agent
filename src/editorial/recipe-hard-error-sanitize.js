/**
 * Deterministic cleanup for hard validation errors that GPT often leaves behind.
 * Runs after other enrichers so the review loop can converge.
 */

/**
 * Drop cuts whose wordIds are not from the segment's audio/video clip.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function sanitizeInvalidWordCuts(recipe) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (!clipId || !Array.isArray(segment.cuts) || segment.cuts.length === 0) {
        continue;
      }
      const prefix = `${clipId}_`;
      segment.cuts = segment.cuts.filter((cut) => (
        String(cut.startWordId ?? "").startsWith(prefix)
        && String(cut.endWordId ?? "").startsWith(prefix)
      ));
    }
  }
  return recipe;
}

/**
 * Mark 2nd+ uses of the same sceneId in an output with allowBrollReuse.
 * @param {object} recipe
 * @returns {object} recipe
 */
export function allowRepeatedSceneReuse(recipe) {
  for (const output of recipe.outputs ?? []) {
    const seen = new Set();
    for (const segment of output.timeline ?? []) {
      const sceneId = segment.videoRef?.sceneId ?? segment.sourceRef?.sceneId;
      if (!sceneId) {
        continue;
      }
      if (seen.has(sceneId)) {
        segment.allowBrollReuse = true;
      } else {
        seen.add(sceneId);
      }
    }
  }
  return recipe;
}

function sceneMatchesSpeechTopics(sceneId, topicIndex, threshold) {
  return (topicIndex?.topics ?? []).some((topic) =>
    topic.matchingScenes?.some(
      (match) => match.sceneId === sceneId && (match.score ?? 1) >= threshold,
    ),
  );
}

/**
 * Reclassify broll that fails match_speech_topics as aroll (V25-BROLL-03 salvage).
 * @param {object} recipe
 * @param {object} [topicIndex]
 * @returns {object} recipe
 */
export function sanitizeUnmatchedBroll(recipe, topicIndex = null) {
  const strategy = recipe.batchContext?.brollStrategy ?? "match_speech_topics";
  if (strategy !== "match_speech_topics") {
    return recipe;
  }
  const topics = topicIndex?.topics ?? [];
  if (topics.length === 0) {
    return recipe;
  }
  const threshold = recipe.batchContext?.brollMatchThreshold ?? 0.55;
  const clipRegistryMap = new Map(
    (recipe.clipRegistry ?? []).map((clip) => [clip.clipId, clip]),
  );

  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.segmentRole !== "broll") {
        continue;
      }
      const clip = clipRegistryMap.get(segment.videoRef?.clipId);
      if (clip?.clipRole === "broll_pool") {
        continue;
      }
      const sceneId = segment.videoRef?.sceneId;
      if (!sceneId || sceneMatchesSpeechTopics(sceneId, topicIndex, threshold)) {
        continue;
      }
      segment.segmentRole = "aroll";
    }
  }
  return recipe;
}

/**
 * Apply all hard-error sanitizers in place.
 * @param {object} recipe
 * @param {{ topicIndex?: object }} [options]
 * @returns {object} recipe
 */
export function sanitizeRecipeHardErrors(recipe, { topicIndex = null } = {}) {
  sanitizeInvalidWordCuts(recipe);
  allowRepeatedSceneReuse(recipe);
  sanitizeUnmatchedBroll(recipe, topicIndex);
  return recipe;
}
