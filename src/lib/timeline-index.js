import { TimelineIndexSchema } from "../schemas/timeline-index.js";

/**
 * Whether a word belongs to a clip (explicit clipId or wordId prefix).
 * Legacy: no scene clipId, or word with neither clipId nor wordId → true.
 */
export function wordBelongsToClip(word, clipId) {
  if (clipId == null || clipId === "") {
    return true;
  }
  if (word.clipId != null) {
    return word.clipId === clipId;
  }
  if (word.wordId != null) {
    return String(word.wordId).startsWith(`${clipId}_`);
  }
  return true;
}

/**
 * Words in a scene by clip ownership and local time window.
 */
export function filterWordsForScene(scene, words) {
  return words.filter(
    (w) =>
      wordBelongsToClip(w, scene.clipId)
      && w.start >= scene.startSec
      && w.start < scene.endSec,
  );
}

export function attachWordsToScenes(scenes, words) {
  return scenes.map((scene) => {
    const sceneWords = filterWordsForScene(scene, words);

    if (sceneWords.length === 0) {
      return { ...scene, hasSpeech: false };
    }

    return {
      ...scene,
      hasSpeech: true,
      wordRange: {
        firstWordId: sceneWords[0].wordId,
        lastWordId: sceneWords.at(-1).wordId,
      },
    };
  });
}

export function buildTimelineIndex({ batchId, catalog, wordIndexes, keyframeSets, visionSets = [], objectSets = [], userContext = "" }) {
  const allWords = wordIndexes.flatMap((wi) => wi.words);

  const scenes = attachWordsToScenes(catalog.scenes, allWords);
  const keyframes = keyframeSets.flatMap((ks) => ks.keyframes ?? []);
  const visionCaptions = visionSets.flatMap((vs) => vs.captions ?? []);
  const objectDetections = objectSets.flatMap((os) => os.detections ?? []);

  return TimelineIndexSchema.parse({
    version: "1.0",
    batchId,
    userContext,
    clips: catalog.clips.map((c) => ({
      clipId: c.clipId,
      sourcePath: c.sourcePath,
      durationSec: c.durationSec,
      ...(c.aspectRatio ? { aspectRatio: c.aspectRatio } : {}),
    })),
    scenes,
    words: allWords,
    keyframes,
    visionCaptions,
    objectDetections,
    stats: {
      totalDurationSec: catalog.clips.reduce((s, c) => s + c.durationSec, 0),
      totalWords: allWords.length,
      totalScenes: scenes.length,
      fillerWordCount: allWords.filter((w) => w.isFiller).length,
    },
  });
}
