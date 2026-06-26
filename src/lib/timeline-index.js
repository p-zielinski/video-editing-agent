import { TimelineIndexSchema } from "../schemas/timeline-index.js";

export function attachWordsToScenes(scenes, words) {
  return scenes.map((scene) => {
    const sceneWords = words.filter(
      (w) => w.start >= scene.startSec && w.start < scene.endSec,
    );

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
