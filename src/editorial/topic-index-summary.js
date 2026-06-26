/**
 * Compact topic index for critic/fixer LLM payloads — includes matchingScenes for B-roll repair.
 */
export function buildTopicIndexSummary(topicIndex) {
  const topics = topicIndex?.topics ?? [];
  if (topics.length === 0) {
    return undefined;
  }

  return {
    topicCount: topics.length,
    topics: topics.map((topic) => ({
      topicId: topic.topicId,
      label: topic.label,
      matchingScenes: (topic.matchingScenes ?? []).map((scene) => ({
        sceneId: scene.sceneId,
        score: scene.score,
        reasons: scene.reason ?? scene.reasons?.slice(0, 3),
      })).slice(0, 8),
    })),
  };
}
