import { DIRECTOR_BRIEF_CAPS } from "./brief-caps.js";

function mapMatchingScenes(matchingScenes, cap) {
  return (matchingScenes ?? []).map((scene) => ({
    sceneId: scene.sceneId,
    score: scene.score,
    reasons: scene.reason ?? scene.reasons?.slice(0, 3),
  })).slice(0, cap);
}

/**
 * Compact topic index for critic/fixer LLM payloads — includes matchingScenes for B-roll repair.
 */
export function buildTopicIndexSummary(topicIndex) {
  const topics = topicIndex?.topics ?? [];
  if (topics.length === 0) {
    return undefined;
  }

  const matchingScenesCap = DIRECTOR_BRIEF_CAPS.MATCHING_SCENES_CAP;

  if (topics.length <= DIRECTOR_BRIEF_CAPS.TOPIC_INDEX_FULL_THRESHOLD) {
    return {
      topicCount: topics.length,
      topics: topics.map((topic) => ({
        ...topic,
        matchingScenes: mapMatchingScenes(topic.matchingScenes, matchingScenesCap),
      })),
    };
  }

  return {
    topicCount: topics.length,
    topics: topics.map((topic) => ({
      topicId: topic.topicId,
      label: topic.label,
      matchingScenes: mapMatchingScenes(topic.matchingScenes, matchingScenesCap),
    })),
  };
}
