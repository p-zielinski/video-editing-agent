/**
 * Dzieli timeline na segmenty L2 (~5-15 min) do streszczeń.
 */
export function chunkTimelineForL2(scenes, { targetSegmentSec = 600, minSegmentSec = 300 } = {}) {
  if (scenes.length === 0) {
    return [];
  }

  const sorted = [...scenes].sort((a, b) => {
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

export function sceneSummaryInput(scene, words, captions) {
  const sceneWords = words.filter(
    (w) => w.start >= scene.startSec && w.start < scene.endSec,
  );
  const sceneCaptions = captions.filter((c) => c.sceneId === scene.sceneId);

  return {
    sceneId: scene.sceneId,
    clipId: scene.clipId,
    durationSec: scene.durationSec,
    transcript: sceneWords.map((w) => w.word).join(" "),
    fillers: sceneWords.filter((w) => w.isFiller).map((w) => w.word),
    visual: sceneCaptions.map((c) => c.caption).join(" "),
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
    ),
  );
}
