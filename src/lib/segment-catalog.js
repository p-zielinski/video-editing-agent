import { sortScenesByClipOrder } from "./abstraction-chunking.js";
import { buildTopSceneRanks } from "../editorial/scene-rank.js";

export const SUPER_DIRECTOR_MAX_SEGMENT_PICKS = 10;
export const SUPER_DIRECTOR_DURATION_THRESHOLD_SEC = 600;

function resolveTotalDurationSec(timelineIndex) {
  if (timelineIndex?.stats?.totalDurationSec != null) {
    return timelineIndex.stats.totalDurationSec;
  }
  return (timelineIndex?.clips ?? []).reduce(
    (sum, clip) => sum + (clip.durationSec ?? 0),
    0,
  );
}

function collectClipIdsForScenes(sceneIds, timelineIndex) {
  const sceneById = new Map(
    (timelineIndex?.scenes ?? []).map((scene) => [scene.sceneId, scene]),
  );
  const clipIds = new Set();
  for (const sceneId of sceneIds ?? []) {
    const scene = sceneById.get(sceneId);
    if (scene?.clipId) {
      clipIds.add(scene.clipId);
    }
  }
  return [...clipIds];
}

function computeSegmentDurationSec(segment, timelineIndex) {
  if (segment.endSec != null && segment.startSec != null) {
    return Math.max(0, segment.endSec - segment.startSec);
  }

  const sceneById = new Map(
    (timelineIndex?.scenes ?? []).map((scene) => [scene.sceneId, scene]),
  );
  let total = 0;
  for (const sceneId of segment.sceneIds ?? []) {
    const scene = sceneById.get(sceneId);
    if (scene?.durationSec != null) {
      total += scene.durationSec;
    }
  }
  return total;
}

/**
 * L2 segment cards for the super-director router (summaries only, no L1 drill-down).
 */
export function buildSegmentCatalog(abstraction, timelineIndex, clipRegistry = []) {
  const l2 = abstraction?.L2 ?? [];
  const sortedScenes = sortScenesByClipOrder(timelineIndex?.scenes ?? [], clipRegistry);

  return l2.map((segment) => {
    const sceneIds = (segment.sceneIds ?? []).filter((sceneId) =>
      sortedScenes.some((scene) => scene.sceneId === sceneId),
    );
    const segmentScenes = sortedScenes.filter((scene) => sceneIds.includes(scene.sceneId));
    const topSceneRanks = buildTopSceneRanks(
      abstraction,
      { ...timelineIndex, scenes: segmentScenes },
      null,
      { limit: 3, clipRegistry },
    );

    return {
      segmentId: segment.segmentId,
      summary: segment.summary ?? "",
      durationSec: computeSegmentDurationSec(segment, timelineIndex),
      sceneIds,
      clipIds: collectClipIdsForScenes(sceneIds, timelineIndex),
      startSec: segment.startSec,
      endSec: segment.endSec,
      narrativeRole: segment.narrativeRole,
      topSceneRanks,
      speechSceneCount: segmentScenes.filter((scene) => scene.hasSpeech).length,
      brollSceneCount: segmentScenes.filter((scene) => !scene.hasSpeech).length,
    };
  });
}

function tokenizeUserContext(userContext = "") {
  return String(userContext)
    .toLowerCase()
    .split(/[^a-z0-9ąćęłńóśźż]+/i)
    .filter((token) => token.length >= 3);
}

/**
 * Keyword overlap fallback when the router needs deterministic segment ordering hints.
 */
export function rankSegmentsByUserContext(userContext, catalog) {
  const tokens = tokenizeUserContext(userContext);
  if (tokens.length === 0) {
    return [...catalog];
  }

  return [...catalog].sort((a, b) => {
    const scoreFor = (card) => {
      const haystack = String(card.summary ?? "").toLowerCase();
      return tokens.reduce(
        (score, token) => score + (haystack.includes(token) ? 1 : 0),
        0,
      );
    };
    const scoreDiff = scoreFor(b) - scoreFor(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return (a.startSec ?? 0) - (b.startSec ?? 0);
  });
}

export function shouldUseSuperDirector(timelineIndex, abstraction, batchContext = {}) {
  if (batchContext.forceClassicDirector === true) {
    return false;
  }

  const durationThreshold = batchContext.superDirectorDurationThresholdSec
    ?? SUPER_DIRECTOR_DURATION_THRESHOLD_SEC;
  const durationSec = resolveTotalDurationSec(timelineIndex);
  const l2Count = abstraction?.L2?.length ?? 0;
  return durationSec > durationThreshold || l2Count > 1;
}

export function resolveNarrativeRoleForSegment(segmentId, abstraction) {
  const segment = (abstraction?.L2 ?? []).find((entry) => entry.segmentId === segmentId);
  return segment?.narrativeRole ?? null;
}

export function resolveSegmentPicks(superPlan, catalog, batchContext = {}) {
  const maxPicks = batchContext.superDirectorMaxSegments ?? SUPER_DIRECTOR_MAX_SEGMENT_PICKS;
  const catalogById = new Map(catalog.map((card) => [card.segmentId, card]));
  const orderIndex = new Map(
    (superPlan.segmentOrder ?? []).map((segmentId, index) => [segmentId, index]),
  );

  const picks = (superPlan.segmentPicks ?? [])
    .filter((pick) => catalogById.has(pick.segmentId))
    .sort((a, b) => {
      const orderDiff = (orderIndex.get(a.segmentId) ?? 999)
        - (orderIndex.get(b.segmentId) ?? 999);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      return a.priority - b.priority;
    })
    .slice(0, maxPicks);

  return picks.map((pick) => ({
    ...pick,
    catalogCard: catalogById.get(pick.segmentId),
  }));
}
