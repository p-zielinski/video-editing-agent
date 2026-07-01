function buildClipRegistryMap(clipRegistry = []) {
  return new Map(clipRegistry.map((clip) => [clip.clipId, clip]));
}

function isVoBrollException(segment, clipRegistryMap) {
  if (segment.segmentRole !== "broll") {
    return false;
  }
  if (segment.audioPolicy !== "from_audio_ref") {
    return false;
  }
  const audioClip = clipRegistryMap.get(segment.audioRef?.clipId);
  return Boolean(audioClip?.hasSpeech || (audioClip?.speechWordCount ?? 0) > 0);
}

/**
 * Validates B-roll segments against batchContext.brollStrategy.
 */
export function validateBrollStrategy(recipe, { topicIndex } = {}) {
  const issues = [];
  const strategy = recipe.batchContext?.brollStrategy ?? "match_speech_topics";
  if (strategy === "director_choice") {
    return issues;
  }

  const clipRegistryMap = buildClipRegistryMap(recipe.clipRegistry ?? []);
  const threshold = recipe.batchContext?.brollMatchThreshold ?? 0.55;

  for (const output of recipe.outputs ?? []) {
    const brollSegments = (output.timeline ?? []).filter(
      (segment) => segment.segmentRole === "broll",
    );

    if (strategy === "minimal") {
      const violations = brollSegments.filter(
        (segment) => !isVoBrollException(segment, clipRegistryMap),
      );
      if (violations.length > 0) {
        issues.push({
          severity: "error",
          code: "V25-BROLL-02",
          message: `brollStrategy=minimal: ${violations.length} segmentów broll poza VO`,
          outputId: output.outputId,
          sceneId: violations[0].videoRef?.sceneId,
        });
      }
      continue;
    }

    for (const segment of brollSegments) {
      const clip = clipRegistryMap.get(segment.videoRef?.clipId);
      const sceneId = segment.videoRef?.sceneId;

      if (strategy === "match_speech_topics" && clip?.clipRole !== "broll_pool") {
        const inIndex = (topicIndex?.topics ?? []).some((topic) =>
          topic.matchingScenes?.some(
            (match) => match.sceneId === sceneId && (match.score ?? 1) >= threshold,
          ),
        );
        if (!inIndex && (topicIndex?.topics?.length ?? 0) > 0) {
          issues.push({
            severity: "error",
            code: "V25-BROLL-03",
            message: `B-roll ${sceneId} poza topicIndex (score < ${threshold}) przy match_speech_topics`,
            outputId: output.outputId,
            sceneId,
          });
        }
      }

      if (strategy === "chronological" && clip?.clipRole !== "broll_pool") {
        issues.push({
          severity: "warning",
          code: "V25-BROLL-04",
          message: `B-roll ${segment.videoRef?.clipId} nie z broll_pool przy chronological`,
          outputId: output.outputId,
          sceneId,
        });
      }
    }

    if (strategy === "chronological" && brollSegments.length > 1) {
      let maxBrollSort = -1;
      for (const segment of brollSegments) {
        const sortIdx = clipRegistryMap.get(segment.videoRef?.clipId)?.sortIndex ?? 0;
        if (sortIdx < maxBrollSort) {
          issues.push({
            severity: "warning",
            code: "V25-BROLL-05",
            message: "B-roll chronological: malejący sortIndex między segmentami broll",
            outputId: output.outputId,
            sceneId: segment.videoRef?.sceneId,
          });
          break;
        }
        maxBrollSort = Math.max(maxBrollSort, sortIdx);
      }
    }
  }

  return issues;
}
