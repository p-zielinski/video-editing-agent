import { buildAudioIndexSummary } from "./audio-index-summary.js";
import { buildTopicIndexSummary } from "./topic-index-summary.js";

const MAX_WORDS_PER_SCENE = 80;

export function formatSpatialSummary(spatialIndex) {
  return (spatialIndex.scenes ?? [])
    .filter((entry) => entry.anchors?.length > 0)
    .map((entry) => ({
      sceneId: entry.sceneId,
      primaryAnchor: entry.anchors[0],
      anchorTypes: [...new Set(entry.anchors.map((a) => a.type))],
    }));
}

export function extractSceneIdsFromRecipe(recipe) {
  return [
    ...new Set(
      recipe.outputs.flatMap((output) =>
        output.timeline.flatMap((segment) => [
          segment.videoRef?.sceneId,
          segment.audioRef?.sceneId,
        ].filter(Boolean)),
      ),
    ),
  ];
}

export function buildTranscriptExcerpts(
  timelineIndex,
  { maxWordsPerScene = MAX_WORDS_PER_SCENE, sceneIds = null } = {},
) {
  const idSet = sceneIds ? new Set(sceneIds) : null;

  return (timelineIndex.scenes ?? [])
    .filter((scene) => scene.hasSpeech && (!idSet || idSet.has(scene.sceneId)))
    .map((scene) => {
      const words = (timelineIndex.words ?? [])
        .filter((w) => w.start >= scene.startSec && w.start < scene.endSec)
        .slice(0, maxWordsPerScene)
        .map((w) => ({
          wordId: w.wordId,
          word: w.word,
          start: w.start,
          end: w.end,
          isFiller: w.isFiller,
        }));

      return {
        sceneId: scene.sceneId,
        clipId: scene.clipId,
        words,
      };
    })
    .filter((entry) => entry.words.length > 0);
}

/**
 * Shared editorial fields for director, critic, and fixer LLM payloads.
 */
export function buildEditorialContext({
  timelineIndex,
  recipe,
  audioIndex,
  topicIndex,
  spatialIndex,
  sceneIds,
  includeFullTopicIndex = false,
  perClipAnalysis,
  wordIndexes,
}) {
  const resolvedSceneIds = sceneIds ?? (recipe ? extractSceneIdsFromRecipe(recipe) : null);

  const transcriptExcerpts = timelineIndex
    ? buildTranscriptExcerpts(timelineIndex, {
        sceneIds: resolvedSceneIds ?? undefined,
      })
    : [];

  const context = {
    transcriptExcerpts,
  };

  const audioSummary = buildAudioIndexSummary(audioIndex, {
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
  });
  if (audioSummary) {
    context.audioIndex = audioSummary;
  }

  if (includeFullTopicIndex) {
    context.topicIndex = topicIndex ?? { topics: [] };
  } else {
    const topicSummary = buildTopicIndexSummary(topicIndex);
    if (topicSummary) {
      context.topicIndex = topicSummary;
    }
  }

  if (spatialIndex) {
    context.spatialIndex = {
      scenes: formatSpatialSummary(spatialIndex),
    };
  }

  return context;
}

const DEAD_AIR_MONTAGE_TECHNIQUES = ["silence_beat", "hard_cut_energy"];
const MAX_DEAD_AIR_MONTAGE_HINTS = 10;

/**
 * Suggest montage actions for high-confidence dead air (RMS + transcript fusion).
 * Brief-only hints for the director — does not mutate the recipe.
 */
export function buildDeadAirMontageHints(audioIndexSummary) {
  if (!audioIndexSummary?.clips?.length) {
    return [];
  }

  const hints = [];
  for (const clip of audioIndexSummary.clips) {
    for (const deadAir of clip.deadAirHints ?? []) {
      if (deadAir.source !== "both") {
        continue;
      }
      hints.push({
        clipId: clip.clipId,
        startSec: deadAir.startSec,
        endSec: deadAir.endSec,
        source: deadAir.source,
        durationSec: Math.round((deadAir.endSec - deadAir.startSec) * 10) / 10,
        suggestedTechniques: DEAD_AIR_MONTAGE_TECHNIQUES,
        suggestion:
          `High-confidence dead air ${deadAir.startSec.toFixed(1)}–${deadAir.endSec.toFixed(1)}s: `
          + "trim segment at endSec or anchor silence_beat / hard_cut_energy near the cut",
      });
    }
  }

  return hints
    .sort((a, b) => b.durationSec - a.durationSec)
    .slice(0, MAX_DEAD_AIR_MONTAGE_HINTS);
}

const CROSS_CHECK_EDITORIAL_KEYS = ["transcriptExcerpts", "audioIndex"];
const TOP_LEVEL_INDEX_KEYS = ["topicIndex", "spatialIndex"];

function pickEditorialFields(editorial, keys) {
  const picked = {};
  for (const key of keys) {
    if (key === "transcriptExcerpts") {
      picked.transcriptExcerpts = editorial.transcriptExcerpts ?? [];
    } else if (editorial[key] != null) {
      picked[key] = editorial[key];
    }
  }
  return picked;
}

/**
 * Merge editorial context fields into an agent LLM payload.
 * nestKey null → transcriptExcerpts, audioIndex, topicIndex, spatialIndex at top level.
 * nestKey "timelineCrossCheck" → transcript+audio nested; topicIndex/spatialIndex at top level.
 */
export function spreadEditorialToPayload(payload, editorial, { nestKey } = {}) {
  const crossCheckFields = pickEditorialFields(editorial, CROSS_CHECK_EDITORIAL_KEYS);
  const indexFields = pickEditorialFields(editorial, TOP_LEVEL_INDEX_KEYS);

  if (nestKey) {
    payload[nestKey] = {
      ...(payload[nestKey] ?? {}),
      ...crossCheckFields,
    };
    Object.assign(payload, indexFields);
  } else {
    Object.assign(payload, crossCheckFields, indexFields);
  }

  return payload;
}
