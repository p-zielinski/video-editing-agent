import {
  listAvailableTracks,
  resolveTrackById,
} from "./music-library.js";
import { suggestMusicBedVolumeDb } from "../lib/music-ai-enrich.js";

const SHORT_USE_CASE_TAGS = new Set(["shorts", "short", "reel", "reels", "hook"]);
const VLOG_USE_CASE_TAGS = new Set(["vlog", "youtube", "main"]);

function normalizeTag(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ");
}

function collectTrackTags(track) {
  const tags = new Set();
  for (const mood of track.mood ?? []) {
    tags.add(normalizeTag(mood));
  }
  for (const useCase of track.useCase ?? []) {
    tags.add(normalizeTag(useCase));
  }
  const pixabay = track.pixabay ?? {};
  for (const bucket of ["genre", "mood", "movement", "theme"]) {
    for (const entry of pixabay[bucket] ?? []) {
      tags.add(normalizeTag(entry));
    }
  }
  return tags;
}

function hasAnyTag(tags, candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeTag(candidate);
    for (const tag of tags) {
      if (tag === normalized || tag.includes(normalized) || normalized.includes(tag)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {object} params
 */
export function buildMusicCuratorContext({
  abstraction,
  audioIndex = null,
  batchContext = {},
  requiredFormats = [],
  userContext = "",
} = {}) {
  const batchSummary = audioIndex?.batchSummary ?? {};
  const hasShort = requiredFormats.includes("9:16");
  const shortOnly = hasShort && !requiredFormats.includes("16:9");
  const l3 = abstraction?.L3 ?? {};

  let targetEnergy = "medium";
  const moodText = [
    l3.sessionSummary,
    l3.narrativeArc,
    userContext,
    batchContext.theme,
    batchContext.notes,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/energet|dynamic|short|reel|gaming|party|club|chase|run/i.test(moodText)) {
    targetEnergy = "high";
  } else if (/calm|reflect|slow|breath|soft/i.test(moodText)) {
    targetEnergy = "low";
  }

  return {
    hasShort,
    shortOnly,
    targetEnergy,
    dominantMood: batchSummary.dominantMood ?? null,
    estimatedBpm: batchSummary.estimatedBpm ?? null,
    shortsMaxDurationSec: batchContext.shortsMaxDurationSec ?? 60,
    sessionSummary: l3.sessionSummary ?? "",
    narrativeArc: l3.narrativeArc ?? "",
    userContext: String(userContext ?? ""),
    theme: batchContext.theme ?? null,
  };
}

function scoreTrackForContext(track, context) {
  const tags = collectTrackTags(track);
  let score = 0;

  if (context.hasShort) {
    if (hasAnyTag(tags, [...SHORT_USE_CASE_TAGS, "music for videos", "music for youtube videos"])) {
      score += 2;
    }
    if (hasAnyTag(tags, ["energetic", "upbeat", "dance", "electronic", "bright"])) {
      score += 1.5;
    }
    if (hasAnyTag(tags, ["medium fast", "chasing", "running", "restless"])) {
      score += 1;
    }
    if (track.energy === "high" || context.targetEnergy === "high") {
      score += track.energy === "high" ? 1 : 0.25;
    }
    if (Number.isFinite(track.durationSec) && track.durationSec >= context.shortsMaxDurationSec * 0.8) {
      score += 0.5;
    }
  } else {
    if (hasAnyTag(tags, [...VLOG_USE_CASE_TAGS, "vlog music", "calm", "reflective"])) {
      score += 1.5;
    }
  }

  if (context.dominantMood && hasAnyTag(tags, [context.dominantMood])) {
    score += 1;
  }

  if (Number.isFinite(context.estimatedBpm) && Number.isFinite(track.bpm)) {
    const delta = Math.abs(track.bpm - context.estimatedBpm);
    if (delta <= 10) {
      score += 1.5;
    } else if (delta <= 20) {
      score += 0.75;
    }
  }

  if (track.trackId === "shorts_energy_01" && context.hasShort) {
    score += 0.5;
  }

  return Math.round(score * 1000) / 1000;
}

/**
 * Compact track payload for music curator LLM (not full catalog).
 * @param {object} track
 */
export function formatTrackForCuratorBrief(track) {
  return {
    trackId: track.trackId,
    title: track.title ?? track.trackId,
    description: track.description ?? null,
    bpm: track.bpm ?? null,
    durationSec: track.durationSec ?? null,
    energy: track.energy ?? null,
    mood: track.mood ?? [],
    useCase: track.useCase ?? [],
    goodFor: track.goodFor ?? [],
    hasVocals: track.hasVocals === true,
    directorUseCases: track.directorUseCases ?? [],
    integratedLufs: track.integratedLufs ?? null,
    suggestedBedVolumeDb: track.suggestedBedVolumeDb ?? suggestMusicBedVolumeDb(track),
    pixabay: track.pixabay ?? null,
  };
}

/**
 * Attach catalog metadata to musicSelection for director brief.
 */
export function enrichMusicSelectionFromCatalog(musicSelection, { catalogPath } = {}) {
  if (!musicSelection?.trackId) {
    return musicSelection;
  }
  const { track } = resolveTrackById(musicSelection.trackId, { catalogPath });
  if (!track) {
    return musicSelection;
  }
  const brief = formatTrackForCuratorBrief(track);
  return {
    ...musicSelection,
    description: brief.description,
    bpm: brief.bpm,
    durationSec: brief.durationSec,
    energy: brief.energy,
    mood: brief.mood,
    useCase: brief.useCase,
    goodFor: brief.goodFor,
    hasVocals: brief.hasVocals,
    directorUseCases: brief.directorUseCases,
    suggestedBedVolumeDb: brief.suggestedBedVolumeDb,
  };
}

/**
 * Deterministic shortlist for music curator.
 * @param {object} context — from buildMusicCuratorContext
 * @param {{ limit?: number, catalogPath?: string }} [options]
 */
export function buildMusicCuratorShortlist(context, { limit = 15, catalogPath } = {}) {
  const tracks = listAvailableTracks(catalogPath);
  const ranked = tracks
    .map((track) => ({
      track,
      score: scoreTrackForContext(track, context),
    }))
    .sort((a, b) => b.score - a.score || a.track.trackId.localeCompare(b.track.trackId));

  const positive = ranked.filter((entry) => entry.score > 0);
  const pool = (positive.length > 0 ? positive : ranked).slice(0, limit);
  return pool.map((entry) => formatTrackForCuratorBrief(entry.track));
}

/**
 * Pick best track without LLM from shortlist scores.
 * @param {object} context
 * @param {object[]} shortlist
 * @param {{ catalogPath?: string }} [options]
 */
export function pickTrackDeterministic(context, shortlist, { catalogPath } = {}) {
  if (!shortlist?.length) {
    return null;
  }

  const tracks = shortlist
    .map((entry) => resolveTrackById(entry.trackId, { catalogPath }).track)
    .filter(Boolean);

  if (!tracks.length) {
    return null;
  }

  const best = tracks
    .map((track) => ({ track, score: scoreTrackForContext(track, context) }))
    .sort((a, b) => b.score - a.score)[0];

  return {
    trackId: best.track.trackId,
    title: best.track.title ?? best.track.trackId,
    reason: "Deterministic match z shortlisty (mood/BPM/useCase)",
    confidence: 0.55,
    source: "deterministic",
  };
}
