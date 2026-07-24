import { DIRECTOR_BRIEF_CAPS } from "../editorial/brief-caps.js";
import { filterWordsForScene } from "./timeline-index.js";
import { sampleWordsAcrossScene } from "./word-sampling.js";

function sceneDurationSec(scene) {
  return scene.durationSec ?? (scene.endSec - scene.startSec);
}

/**
 * Sort scenes by clip ingest order (sortIndex) then in-clip time.
 */
export function sortScenesByClipOrder(scenes, clipRegistry = []) {
  const orderByClipId = new Map(
    (clipRegistry ?? []).map((clip) => [clip.clipId, clip.sortIndex ?? 0]),
  );

  return [...scenes].sort((a, b) => {
    const aOrder = orderByClipId.has(a.clipId)
      ? orderByClipId.get(a.clipId)
      : Number.MAX_SAFE_INTEGER;
    const bOrder = orderByClipId.has(b.clipId)
      ? orderByClipId.get(b.clipId)
      : Number.MAX_SAFE_INTEGER;

    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return (a.startSec ?? 0) - (b.startSec ?? 0);
  });
}

/**
 * Groups clips by calendar day from creationTime metadata.
 * @returns {Array<{ dayId: string, date: string, clipIds: string[] }>}
 */
export function buildDaySegments(clipRegistry = []) {
  const clipsWithTime = (clipRegistry ?? [])
    .filter((clip) => clip.creationTime)
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));

  if (clipsWithTime.length < 2) {
    return [];
  }

  const segments = [];
  let current = null;

  for (const clip of clipsWithTime) {
    const date = clip.creationTime.slice(0, 10);
    if (!current || current.date !== date) {
      if (current) {
        segments.push(current);
      }
      current = {
        dayId: `day_${date}`,
        date,
        clipIds: [clip.clipId],
      };
    } else {
      current.clipIds.push(clip.clipId);
    }
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

/**
 * Dzieli timeline na segmenty L2 (~5-15 min) do streszczeń.
 * Uses sum of scene durations (global clock) — not local endSec - startSec across clips.
 */
export function chunkTimelineForL2(scenes, { targetSegmentSec = 600, minSegmentSec = 300, clipRegistry = [] } = {}) {
  if (scenes.length === 0) {
    return [];
  }

  const sorted = clipRegistry.length > 0
    ? sortScenesByClipOrder(scenes, clipRegistry)
    : [...scenes].sort((a, b) => {
      if (a.clipId !== b.clipId) {
        return a.clipId.localeCompare(b.clipId);
      }
      return a.startSec - b.startSec;
    });

  const firstDur = sceneDurationSec(sorted[0]);
  const segments = [];
  let current = {
    segmentId: "seg001",
    startSec: 0,
    endSec: firstDur,
    sceneIds: [sorted[0].sceneId],
  };
  let currentDuration = firstDur;
  let globalEnd = firstDur;
  let segIndex = 1;

  for (let i = 1; i < sorted.length; i += 1) {
    const scene = sorted[i];
    const dur = sceneDurationSec(scene);

    if (
      currentDuration >= targetSegmentSec
      && currentDuration >= minSegmentSec
      && current.sceneIds.length > 0
    ) {
      segments.push({ ...current });
      segIndex += 1;
      current = {
        segmentId: `seg${String(segIndex).padStart(3, "0")}`,
        startSec: globalEnd,
        endSec: globalEnd + dur,
        sceneIds: [scene.sceneId],
      };
      currentDuration = dur;
      globalEnd += dur;
    } else {
      current.endSec = globalEnd + dur;
      current.sceneIds.push(scene.sceneId);
      currentDuration += dur;
      globalEnd += dur;
    }
  }

  if (current.sceneIds.length > 0) {
    segments.push(current);
  }

  return segments;
}

export function sceneSummaryInput(scene, words, captions, objectDetections = [], {
  maxWords = DIRECTOR_BRIEF_CAPS.maxWordsPerScene,
} = {}) {
  const sceneWords = sampleWordsAcrossScene(
    filterWordsForScene(scene, words),
    maxWords,
  );
  const sceneCaptions = captions.filter((c) => c.sceneId === scene.sceneId);
  const sceneObjects = objectDetections.filter((d) => d.sceneId === scene.sceneId);
  const objectLabels = [...new Set(
    sceneObjects.map((d) => d.label).filter(Boolean),
  )].slice(0, 8);

  return {
    sceneId: scene.sceneId,
    clipId: scene.clipId,
    durationSec: scene.durationSec,
    transcript: sceneWords.map((w) => w.word).join(" "),
    fillers: sceneWords.filter((w) => w.isFiller).map((w) => w.word),
    visual: sceneCaptions.map((c) => c.caption).join(" "),
    ...(objectLabels.length > 0 ? { objectLabels } : {}),
  };
}

export function enrichSceneInputWithClipMeta(sceneInput, clipRegistry = []) {
  const clip = clipRegistry.find((entry) => entry.clipId === sceneInput.clipId);
  if (!clip) {
    return sceneInput;
  }

  return {
    ...sceneInput,
    clipRole: clip.clipRole,
    mediaType: clip.mediaType,
    hasSpeech: clip.hasSpeech ?? Boolean(sceneInput.transcript?.trim()),
  };
}

export function drillDownSceneDetails(timelineIndex, sceneIds) {
  const idSet = new Set(sceneIds);
  const scenes = timelineIndex.scenes.filter((s) => idSet.has(s.sceneId));

  return scenes.map((scene) =>
    sceneSummaryInput(
      scene,
      timelineIndex.words,
      timelineIndex.visionCaptions,
      timelineIndex.objectDetections,
    ),
  );
}
