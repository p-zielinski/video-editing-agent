import { computeSceneRank } from "./scene-rank.js";

function visualQualityScore(quality) {
  if (quality === "high") {
    return 1;
  }
  if (quality === "medium") {
    return 0.55;
  }
  return 0.25;
}

/** Normalized bbox as xywh (0–1), matching spatial index. */
function bboxArea(bbox) {
  if (!bbox || bbox.length < 4) {
    return 0;
  }
  const [x, y, w, h] = bbox;
  return Math.min(1, Math.max(0, w) * Math.max(0, h) * 4);
}

function pickFaceAnchorNearTimestamp(anchors = [], timestampSec = 0) {
  const faces = anchors.filter((a) => a.type === "face" || a.label === "face");
  const pool = faces.length > 0 ? faces : anchors;
  if (pool.length === 0) {
    return null;
  }

  return pool
    .slice()
    .sort((a, b) => {
      const deltaA = Math.abs((a.timestampSec ?? 0) - timestampSec);
      const deltaB = Math.abs((b.timestampSec ?? 0) - timestampSec);
      if (deltaA !== deltaB) {
        return deltaA - deltaB;
      }
      return bboxArea(b.bbox) - bboxArea(a.bbox);
    })[0];
}

function audioTagsForClip(audioIndex, clipId) {
  const clip = audioIndex?.clips?.find((entry) => entry.clipId === clipId);
  return clip?.editorialTags ?? [];
}

function sceneIdsForOutput(output) {
  const ids = new Set();
  for (const seg of output.timeline ?? []) {
    const refs = [seg.videoRef, seg.audioRef, seg.sourceRef].filter(Boolean);
    for (const ref of refs) {
      if (ref.sceneId) {
        ids.add(ref.sceneId);
      }
    }
  }
  return ids;
}

function timestampCandidatesForScene(scene, spatialScene, timelineIndex) {
  const timestamps = new Set();
  const mid = (scene.startSec ?? 0) + ((scene.durationSec ?? 0) / 2);
  timestamps.add(mid);

  for (const anchor of spatialScene?.anchors ?? []) {
    if (anchor.timestampSec != null) {
      timestamps.add(anchor.timestampSec);
    }
  }

  for (const kf of timelineIndex.keyframes ?? []) {
    if (kf.sceneId === scene.sceneId && kf.timestampSec != null) {
      timestamps.add(kf.timestampSec);
    }
  }

  return [...timestamps].filter((t) =>
    t >= (scene.startSec ?? 0) && t <= (scene.endSec ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * Lightweight 0–1 score for a thumbnail frame candidate.
 */
export function scoreFrameForThumbnail({
  scene,
  l1 = {},
  spatialAnchor,
  visualQuality,
  isHookScene = false,
  audioTags = [],
  timelineIndex = {},
}) {
  const quality = visualQuality ?? l1.visualQuality ?? "medium";
  const faceArea = spatialAnchor ? bboxArea(spatialAnchor.bbox) : 0;
  const rank = computeSceneRank(scene, l1, timelineIndex, { audioTags });
  const hookBoost = isHookScene ? 0.15 : 0;

  const score = 0.35 * faceArea
    + 0.25 * visualQualityScore(quality)
    + 0.3 * rank
    + hookBoost;

  return Math.min(1, Math.round(score * 1000) / 1000);
}

/**
 * Top thumbnail frame candidates for one recipe output.
 */
export function shortlistThumbnailFrames({
  recipe,
  timelineIndex,
  abstraction,
  spatialIndex,
  audioIndex,
  outputId,
  maxCandidates = 10,
}) {
  const output = (recipe.outputs ?? []).find((entry) => entry.outputId === outputId)
    ?? recipe.outputs?.[0];
  if (!output) {
    return [];
  }

  const usedSceneIds = sceneIdsForOutput(output);
  const hookSceneId = output.timeline?.[0]?.videoRef?.sceneId
    ?? output.timeline?.[0]?.sourceRef?.sceneId
    ?? null;

  const spatialByScene = new Map((spatialIndex?.scenes ?? []).map((s) => [s.sceneId, s]));
  const l1ByScene = new Map((abstraction?.L1 ?? []).map((entry) => [entry.sceneId, entry]));

  const candidates = [];

  for (const scene of timelineIndex.scenes ?? []) {
    if (!usedSceneIds.has(scene.sceneId)) {
      continue;
    }

    const l1 = l1ByScene.get(scene.sceneId) ?? {};
    const spatialScene = spatialByScene.get(scene.sceneId);
    const audioTags = audioTagsForClip(audioIndex, scene.clipId);
    const isHookScene = scene.sceneId === hookSceneId;

    for (const timestampSec of timestampCandidatesForScene(scene, spatialScene, timelineIndex)) {
      const anchor = pickFaceAnchorNearTimestamp(spatialScene?.anchors ?? [], timestampSec);
      const score = scoreFrameForThumbnail({
        scene,
        l1,
        spatialAnchor: anchor,
        visualQuality: l1.visualQuality,
        isHookScene,
        audioTags,
        timelineIndex,
      });

      candidates.push({
        clipId: scene.clipId,
        sceneId: scene.sceneId,
        timestampSec: Math.round(timestampSec * 100) / 100,
        score,
        hasFace: Boolean(anchor && (anchor.type === "face" || anchor.label === "face")),
        visualQuality: l1.visualQuality ?? "medium",
        faceBbox: anchor?.bbox ?? null,
      });
    }
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score || a.sceneId.localeCompare(b.sceneId))
    .filter((entry) => {
      const key = `${entry.sceneId}:${entry.timestampSec}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, maxCandidates);
}
