import { buildAudioIndexSummary } from "./audio-index-summary.js";
import { buildTopicIndexSummary } from "./topic-index-summary.js";
import { resolveRecipeNarrativeProfile } from "../lib/narrative-profile.js";
import { filterWordsForScene } from "../lib/timeline-index.js";

const MAX_WORDS_PER_SCENE = 80;

export function formatSpatialSummary(spatialIndex, { anchorLimit = 1 } = {}) {
  return (spatialIndex.scenes ?? [])
    .filter((entry) => entry.anchors?.length > 0)
    .map((entry) => {
      const anchors = entry.anchors.slice(0, anchorLimit);
      return {
        sceneId: entry.sceneId,
        primaryAnchor: anchors[0],
        ...(anchors.length > 1 ? { anchors } : {}),
        anchorTypes: [...new Set(entry.anchors.map((a) => a.type))],
      };
    });
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
  const idSet = sceneIds?.length ? new Set(sceneIds) : null;

  return (timelineIndex.scenes ?? [])
    .filter((scene) => scene.hasSpeech && (!idSet || idSet.has(scene.sceneId)))
    .map((scene) => {
      const words = filterWordsForScene(scene, timelineIndex.words ?? [])
        .slice(0, maxWordsPerScene)
        .map((w) => ({
          wordId: w.wordId,
          word: w.displayWord ?? w.word,
          start: w.start,
          end: w.end,
          isFiller: w.isFiller,
          ...(w.safetyClass ? { safetyClass: w.safetyClass } : {}),
          ...(w.safetyAction ? { safetyAction: w.safetyAction } : {}),
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
  spatialAnchorLimit = 1,
  maxWordsPerScene = MAX_WORDS_PER_SCENE,
  audioCaps,
  perClipAnalysis,
  wordIndexes,
}) {
  const extracted = sceneIds ?? (recipe ? extractSceneIdsFromRecipe(recipe) : null);
  // Empty recipe timelines → no scene filter (segment director needs all speech)
  const resolvedSceneIds = extracted?.length ? extracted : null;

  const transcriptExcerpts = timelineIndex
    ? buildTranscriptExcerpts(timelineIndex, {
        sceneIds: resolvedSceneIds,
        maxWordsPerScene,
      })
    : [];

  const context = {
    transcriptExcerpts,
  };

  const audioSummary = buildAudioIndexSummary(audioIndex, {
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
    caps: audioCaps,
    narrativeProfile: resolveRecipeNarrativeProfile(recipe),
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
      scenes: formatSpatialSummary(spatialIndex, { anchorLimit: spatialAnchorLimit }),
    };
  }

  return context;
}

const DEAD_AIR_MONTAGE_TECHNIQUES = ["silence_beat", "hard_cut_energy"];
const MAX_DEAD_AIR_MONTAGE_HINTS = 10;

function isCutEligibleDeadAirHint(deadAir) {
  if (deadAir.source !== "both") {
    return false;
  }
  if (deadAir.silenceKind == null) {
    return true;
  }
  return deadAir.silenceKind === "dead_air";
}

function isSilenceBeatDipEligibleHint(deadAir) {
  return deadAir.source === "both" && deadAir.silenceKind === "breath_before_punchline";
}

function hintToMontageEntry(clip, deadAir, suggestedTechniques, suggestion) {
  return {
    clipId: clip.clipId,
    startSec: deadAir.startSec,
    endSec: deadAir.endSec,
    source: deadAir.source,
    ...(deadAir.silenceKind ? { silenceKind: deadAir.silenceKind } : {}),
    durationSec: Math.round((deadAir.endSec - deadAir.startSec) * 10) / 10,
    suggestedTechniques,
    suggestion,
  };
}

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
      if (!isCutEligibleDeadAirHint(deadAir)) {
        continue;
      }
      const kindLabel = deadAir.silenceKind ?? "dead_air";
      hints.push(hintToMontageEntry(
        clip,
        deadAir,
        DEAD_AIR_MONTAGE_TECHNIQUES,
        `High-confidence ${kindLabel} ${deadAir.startSec.toFixed(1)}–${deadAir.endSec.toFixed(1)}s: `
          + "trim segment at endSec or anchor silence_beat / hard_cut_energy near the cut",
      ));
    }
  }

  return hints
    .sort((a, b) => b.durationSec - a.durationSec)
    .slice(0, MAX_DEAD_AIR_MONTAGE_HINTS);
}

/**
 * Optional silence_beat dips for breath_before_punchline (no timeline cut).
 */
export function buildSilenceBeatDipHints(audioIndexSummary) {
  if (!audioIndexSummary?.clips?.length) {
    return [];
  }

  const hints = [];
  for (const clip of audioIndexSummary.clips) {
    for (const deadAir of clip.deadAirHints ?? []) {
      if (!isSilenceBeatDipEligibleHint(deadAir)) {
        continue;
      }
      hints.push(hintToMontageEntry(
        clip,
        deadAir,
        ["silence_beat"],
        `Breath before punchline ${deadAir.startSec.toFixed(1)}–${deadAir.endSec.toFixed(1)}s: `
          + "optional light silence_beat dip only (preserve timing)",
      ));
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
