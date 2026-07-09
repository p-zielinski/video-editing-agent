import {
  isChronologicalFirstScene,
  isGreetingWord,
  isSetupNarrativeScene,
} from "./shorts-greeting.js";

const HIGHLIGHT_AUDIO_TAGS = new Set([
  "laughter",
  "applause",
  "scream",
  "impact",
  "crowd",
  "music",
]);

const TENSION_NARRATIVE_ROLES = new Set(["tension", "climax", "payoff"]);

function visualQualityScore(quality) {
  if (quality === "high") {
    return 1;
  }
  if (quality === "medium") {
    return 0.5;
  }
  return 0.2;
}

function normalizeAudioTagNames(audioTags = []) {
  return audioTags.map((entry) => (typeof entry === "string" ? entry : entry.tag)).filter(Boolean);
}

function audioTagScore(audioTags = []) {
  const names = normalizeAudioTagNames(audioTags);
  if (names.length === 0) {
    return 0;
  }
  if (names.some((tag) => HIGHLIGHT_AUDIO_TAGS.has(tag))) {
    return 1;
  }
  return 0.4;
}

function computeSpeechDensity(scene, timelineIndex) {
  const duration = scene.durationSec ?? Math.max(0, (scene.endSec ?? 0) - (scene.startSec ?? 0));
  if (duration <= 0) {
    return 0;
  }

  const words = (timelineIndex.words ?? []).filter(
    (w) => w.start >= scene.startSec && w.start < scene.endSec && !w.isFiller,
  );
  const wordsPerSec = words.length / duration;
  return Math.min(1, wordsPerSec / 2.5);
}

function sceneOpensWithGreeting(scene, timelineIndex) {
  const words = (timelineIndex.words ?? []).filter(
    (w) => !w.isFiller && w.start >= scene.startSec && w.start < scene.endSec,
  );
  const first = words[0];
  return first ? isGreetingWord(first.word) : false;
}

function narrativeRoleBoost(sceneId, abstraction) {
  for (const segment of abstraction?.L2 ?? []) {
    if (!(segment.sceneIds ?? []).includes(sceneId)) {
      continue;
    }
    if (TENSION_NARRATIVE_ROLES.has(segment.narrativeRole)) {
      return 0.2;
    }
    if (segment.narrativeRole === "setup") {
      return -0.25;
    }
  }
  return 0;
}

function energyPeakBoost(scene, audioIndex) {
  const clip = audioIndex?.clips?.find((entry) => entry.clipId === scene.clipId);
  const peaks = clip?.energyPeaks ?? [];
  if (!peaks.length) {
    return 0;
  }

  const sceneStart = scene.startSec ?? 0;
  const sceneEnd = scene.endSec ?? sceneStart + (scene.durationSec ?? 0);
  const inScene = peaks.filter(
    (peak) => peak.timeSec >= sceneStart && peak.timeSec < sceneEnd,
  );
  if (!inScene.length) {
    return 0;
  }

  const maxRms = Math.max(...inScene.map((peak) => peak.rmsDb ?? -60));
  return maxRms > -18 ? 0.15 : 0.05;
}

function introPenalty(scene, timelineIndex, abstraction) {
  let penalty = 0;
  if (isChronologicalFirstScene(scene.sceneId, timelineIndex)) {
    penalty += 0.15;
  }
  if (isSetupNarrativeScene(scene.sceneId, abstraction)) {
    penalty += 0.2;
  }
  if (sceneOpensWithGreeting(scene, timelineIndex)) {
    penalty += 0.2;
  }
  return penalty;
}

/**
 * Lightweight 0–1 highlight score for a scene.
 * @param {object} scene — timeline index scene entry
 * @param {object} l1 — L1 abstraction entry for the scene
 * @param {object} timelineIndex
 * @param {{ audioTags?: string[] | object[], audioIndex?: object, abstraction?: object }} [options]
 */
export function computeSceneRank(
  scene,
  l1 = {},
  timelineIndex = {},
  { audioTags = [], audioIndex = null, abstraction = null } = {},
) {
  const brollPotential = l1.brollPotential ?? (scene.hasSpeech ? 0.15 : 0.75);
  const visual = visualQualityScore(l1.visualQuality);
  const speech = computeSpeechDensity(scene, timelineIndex);
  const audio = audioTagScore(audioTags);

  const brollWeight = scene.hasSpeech ? 0.25 : 0.4;
  const speechWeight = scene.hasSpeech ? 0.25 : 0.05;

  let score = brollWeight * brollPotential
    + 0.25 * visual
    + speechWeight * speech
    + 0.15 * audio;

  score += narrativeRoleBoost(scene.sceneId, abstraction);
  score += energyPeakBoost(scene, audioIndex);
  score -= introPenalty(scene, timelineIndex, abstraction);

  return Math.min(1, Math.max(0, Math.round(score * 1000) / 1000));
}

function audioTagsForClip(audioIndex, clipId) {
  const clip = audioIndex?.clips?.find((entry) => entry.clipId === clipId);
  if (!clip) {
    return [];
  }
  return clip.editorialTags ?? [];
}

/**
 * Top scene highlight ranks for director brief.
 * @param {object} abstraction
 * @param {object} timelineIndex
 * @param {object|null} [audioIndex]
 * @param {{ limit?: number, clipRegistry?: object[] }} [options]
 */
export function buildTopSceneRanks(
  abstraction,
  timelineIndex,
  audioIndex = null,
  { limit = 10, clipRegistry = [] } = {},
) {
  const registryByClip = new Map((clipRegistry ?? []).map((entry) => [entry.clipId, entry]));

  const ranked = (timelineIndex.scenes ?? []).map((scene) => {
    const l1 = (abstraction.L1 ?? []).find((entry) => entry.sceneId === scene.sceneId) ?? {};
    const clipEntry = registryByClip.get(scene.clipId);
    const audioTags = audioTagsForClip(audioIndex, scene.clipId).length
      ? audioTagsForClip(audioIndex, scene.clipId)
      : (clipEntry?.audioTags ?? []);

    return {
      sceneId: scene.sceneId,
      clipId: scene.clipId,
      rank: computeSceneRank(scene, l1, timelineIndex, {
        audioTags,
        audioIndex,
        abstraction,
      }),
      brollPotential: l1.brollPotential,
      visualQuality: l1.visualQuality,
      hasSpeech: scene.hasSpeech,
    };
  });

  return ranked
    .sort((a, b) => b.rank - a.rank || a.sceneId.localeCompare(b.sceneId))
    .slice(0, limit);
}
