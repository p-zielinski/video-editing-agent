import { computeSceneRank } from "./scene-rank.js";
import {
  clampNormalizedBbox,
  isDogDetection,
  isSubjectDetection,
  normalizeDetectionBboxToFrame,
  resolveThumbnailSourceDimensions,
} from "./thumbnail-compose.js";
import { unionAnchorBbox } from "../render/reframe.js";

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
  const clamped = clampNormalizedBbox(bbox);
  if (!clamped) {
    return 0;
  }
  const [, , w, h] = clamped;
  return Math.min(1, Math.max(0, w * h));
}

function pickAnchorsNearTimestamp(anchors = [], timestampSec = 0, maxDeltaSec = 2.5) {
  if (!anchors.length) {
    return [];
  }

  return anchors
    .map((anchor) => ({
      anchor,
      delta: Math.abs((anchor.timestampSec ?? 0) - timestampSec),
    }))
    .filter((entry) => entry.delta <= maxDeltaSec)
    .sort((a, b) => a.delta - b.delta || bboxArea(b.anchor.bbox) - bboxArea(a.anchor.bbox))
    .map((entry) => entry.anchor);
}

function pickSubjectAnchorsNearTimestamp(anchors = [], timestampSec = 0) {
  const near = pickAnchorsNearTimestamp(anchors, timestampSec);
  const subjects = near.filter((anchor) =>
    anchor.type === "face"
    || anchor.type === "subject"
    || isSubjectDetection(anchor)
    || isDogDetection(anchor));
  return subjects.length > 0 ? subjects : near.slice(0, 1);
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

function detectionTimestampsForScene(detections = [], sceneId) {
  const timestamps = new Set();
  for (const detection of detections) {
    if (detection.sceneId === sceneId && detection.timestampSec != null) {
      timestamps.add(detection.timestampSec);
    }
  }
  return timestamps;
}

function timestampCandidatesForScene(scene, spatialScene, timelineIndex, detections = []) {
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

  for (const timestampSec of detectionTimestampsForScene(detections, scene.sceneId)) {
    timestamps.add(timestampSec);
  }

  return [...timestamps].filter((t) =>
    t >= (scene.startSec ?? 0) && t <= (scene.endSec ?? Number.POSITIVE_INFINITY),
  );
}

function resolveCandidateSubject({
  spatialAnchors = [],
  detections = [],
  timestampSec,
  sceneId = null,
  srcWidth = 1,
  srcHeight = 1,
}) {
  const fromDetections = detections
    .filter((detection) => isSubjectDetection(detection))
    .filter((detection) => !sceneId || !detection.sceneId || detection.sceneId === sceneId)
    .map((detection) => {
      const bbox = normalizeDetectionBboxToFrame(detection.bbox, srcWidth, srcHeight);
      const delta = Math.abs((detection.timestampSec ?? 0) - timestampSec);
      return { bbox, delta, detection };
    })
    .filter((entry) => entry.bbox && entry.delta <= 2.5)
    .sort((a, b) => a.delta - b.delta);

  if (fromDetections.length > 0) {
    const nearest = fromDetections[0].delta;
    const near = fromDetections.filter((entry) => entry.delta <= nearest + 0.35);
    const union = unionAnchorBbox(near.map((entry) => ({ bbox: entry.bbox })));
    const hasDog = near.some((entry) => isDogDetection(entry.detection));
    const hasFace = near.some((entry) =>
      entry.detection.type === "face"
      || String(entry.detection.label ?? "").toLowerCase().includes("face"));
    return {
      subjectBbox: union
        ? clampNormalizedBbox([union.x, union.y, union.w, union.h])
        : near[0].bbox,
      hasDog,
      hasFace,
      faceBbox: near.find((entry) =>
        entry.detection.type === "face"
        || String(entry.detection.label ?? "").toLowerCase().includes("face"))?.bbox
        ?? null,
    };
  }

  const anchors = pickSubjectAnchorsNearTimestamp(spatialAnchors, timestampSec);
  if (anchors.length === 0) {
    return { subjectBbox: null, hasDog: false, hasFace: false, faceBbox: null };
  }
  const union = unionAnchorBbox(anchors);
  return {
    subjectBbox: union
      ? clampNormalizedBbox([union.x, union.y, union.w, union.h])
      : clampNormalizedBbox(anchors[0].bbox),
    hasDog: anchors.some((anchor) => isDogDetection(anchor)),
    hasFace: anchors.some((anchor) => anchor.type === "face" || String(anchor.label ?? "").includes("face")),
    faceBbox: clampNormalizedBbox(
      anchors.find((anchor) => anchor.type === "face")?.bbox ?? null,
    ),
  };
}

/**
 * Lightweight 0–1 score for a thumbnail frame candidate.
 */
export function scoreFrameForThumbnail({
  scene,
  l1 = {},
  spatialAnchor,
  subjectBbox = null,
  visualQuality,
  isHookScene = false,
  audioTags = [],
  timelineIndex = {},
  format = "16:9",
  hasDog = false,
  hasFace = false,
}) {
  const quality = visualQuality ?? l1.visualQuality ?? "medium";
  const faceArea = spatialAnchor ? bboxArea(spatialAnchor.bbox) : bboxArea(subjectBbox);
  const subjectArea = bboxArea(subjectBbox) || faceArea;
  const rank = computeSceneRank(scene, l1, timelineIndex, { audioTags });
  const hookBoost = isHookScene ? 0.12 : 0;
  const contextBoost = hasDog ? 0.18 : (hasFace && subjectArea > faceArea * 1.2 ? 0.08 : 0);

  // Huge face filling the frame is bad for 16:9 (usually a portrait cover-crop artifact).
  const faceFillPenalty = format === "16:9" && faceArea > 0.22
    ? Math.min(0.25, (faceArea - 0.22) * 0.9)
    : 0;

  const faceWeight = format === "16:9" ? 0.12 : 0.28;
  const score = faceWeight * Math.min(faceArea, 0.2)
    + 0.2 * visualQualityScore(quality)
    + 0.28 * rank
    + 0.12 * Math.min(subjectArea, 0.45)
    + hookBoost
    + contextBoost
    - faceFillPenalty;

  return Math.min(1, Math.max(0, Math.round(score * 1000) / 1000));
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
  detectionsByClip = {},
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
  const format = output.format ?? "16:9";

  const spatialByScene = new Map((spatialIndex?.scenes ?? []).map((s) => [s.sceneId, s]));
  const l1ByScene = new Map((abstraction?.L1 ?? []).map((entry) => [entry.sceneId, entry]));
  const clipById = new Map((timelineIndex.clips ?? []).map((clip) => [clip.clipId, clip]));

  const candidates = [];

  for (const scene of timelineIndex.scenes ?? []) {
    if (!usedSceneIds.has(scene.sceneId)) {
      continue;
    }

    const l1 = l1ByScene.get(scene.sceneId) ?? {};
    const spatialScene = spatialByScene.get(scene.sceneId);
    const audioTags = audioTagsForClip(audioIndex, scene.clipId);
    const isHookScene = scene.sceneId === hookSceneId;
    const detections = detectionsByClip[scene.clipId] ?? [];
    const clip = clipById.get(scene.clipId);
    const { srcWidth, srcHeight } = resolveThumbnailSourceDimensions({
      scene,
      clip,
      detections,
    });

    for (const timestampSec of timestampCandidatesForScene(
      scene,
      spatialScene,
      timelineIndex,
      detections,
    )) {
      const resolved = resolveCandidateSubject({
        spatialAnchors: spatialScene?.anchors ?? [],
        detections,
        timestampSec,
        sceneId: scene.sceneId,
        srcWidth,
        srcHeight,
      });
      const faceAnchor = resolved.faceBbox
        ? { type: "face", bbox: resolved.faceBbox }
        : pickSubjectAnchorsNearTimestamp(spatialScene?.anchors ?? [], timestampSec)
          .find((anchor) => anchor.type === "face") ?? null;

      const score = scoreFrameForThumbnail({
        scene,
        l1,
        spatialAnchor: faceAnchor,
        subjectBbox: resolved.subjectBbox,
        visualQuality: l1.visualQuality,
        isHookScene,
        audioTags,
        timelineIndex,
        format,
        hasDog: resolved.hasDog,
        hasFace: resolved.hasFace,
      });

      candidates.push({
        clipId: scene.clipId,
        sceneId: scene.sceneId,
        timestampSec: Math.round(timestampSec * 100) / 100,
        score,
        hasFace: resolved.hasFace,
        hasDog: resolved.hasDog,
        visualQuality: l1.visualQuality ?? "medium",
        faceBbox: resolved.faceBbox,
        subjectBbox: resolved.subjectBbox,
        format,
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
