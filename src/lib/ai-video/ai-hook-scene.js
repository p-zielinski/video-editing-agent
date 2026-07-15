import { buildTopSceneRanks } from "../../editorial/scene-rank.js";

const SPOILER_LOOP_KINDS = new Set(["cold_open", "payoff_tease"]);

/**
 * Scene IDs that would spoil open-loop payoffs if used as AI hook source frames.
 */
export function collectAiHookSpoilerSceneIds(abstraction) {
  const spoilerIds = new Set();
  for (const loop of abstraction?.L3?.openLoops ?? []) {
    if (loop.payoffSceneId) {
      spoilerIds.add(loop.payoffSceneId);
    }
    if (SPOILER_LOOP_KINDS.has(loop.kind) && loop.setupSceneId) {
      spoilerIds.add(loop.setupSceneId);
    }
  }
  return spoilerIds;
}

function sceneHasSourcePath(timelineIndex, sceneId) {
  const scene = (timelineIndex?.scenes ?? []).find((entry) => entry.sceneId === sceneId);
  return Boolean(scene?.sourcePath);
}

/**
 * Deterministic ranked hook scene candidates with spoiler exclusions.
 */
export function rankAiHookSceneCandidates(abstraction, timelineIndex, audioIndex, {
  limit = 20,
} = {}) {
  const spoilerIds = collectAiHookSpoilerSceneIds(abstraction);
  const ranks = buildTopSceneRanks(abstraction, timelineIndex, audioIndex, { limit });

  return ranks
    .filter((entry) => !spoilerIds.has(entry.sceneId))
    .filter((entry) => sceneHasSourcePath(timelineIndex, entry.sceneId))
    .map((entry, index) => ({
      sceneId: entry.sceneId,
      rankScore: entry.rank,
      order: index,
    }));
}

/**
 * Select the next safe AI hook scene after anti-spoiler filtering.
 * @returns {null | { sceneId: string, source: string, selection: object }}
 */
export function selectAiHookScene(abstraction, timelineIndex, audioIndex) {
  const spoilerIds = [...collectAiHookSpoilerSceneIds(abstraction)];
  const candidates = rankAiHookSceneCandidates(abstraction, timelineIndex, audioIndex);

  if (candidates.length === 0) {
    return null;
  }

  const selected = candidates[0];
  return {
    sceneId: selected.sceneId,
    source: "scene_rank_anti_spoiler",
    selection: {
      excludedSpoilerSceneIds: spoilerIds,
      rankedAlternatives: candidates.slice(0, 5).map((entry) => entry.sceneId),
      selectedRankScore: selected.rankScore,
      selectedOrder: selected.order,
    },
  };
}
