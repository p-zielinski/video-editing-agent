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

  const segments = [];
  let current = {
    segmentId: "seg001",
    startSec: sorted[0].startSec,
    endSec: sorted[0].endSec,
    sceneIds: [sorted[0].sceneId],
  };

  let segIndex = 1;

  for (let i = 1; i < sorted.length; i += 1) {
    const scene = sorted[i];
    const duration = scene.endSec - current.startSec;

    if (duration >= targetSegmentSec && current.sceneIds.length > 0 && current.endSec - current.startSec >= minSegmentSec) {
      segments.push({ ...current });
      segIndex += 1;
      current = {
        segmentId: `seg${String(segIndex).padStart(3, "0")}`,
        startSec: scene.startSec,
        endSec: scene.endSec,
        sceneIds: [scene.sceneId],
      };
    } else {
      current.endSec = scene.endSec;
      current.sceneIds.push(scene.sceneId);
    }
  }

  if (current.sceneIds.length > 0) {
    segments.push(current);
  }

  return segments;
}

export function sceneSummaryInput(scene, words, captions, objectDetections = []) {
  const sceneWords = words.filter(
    (w) => w.start >= scene.startSec && w.start < scene.endSec,
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
