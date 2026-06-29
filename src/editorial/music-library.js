import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CATALOG_PATH = path.join(ROOT, "assets", "music", "catalog.json");
const DEFAULT_MUSIC_DIR = path.join(ROOT, "assets", "music");

export const VOICE_TARGET_LUFS = -16;
export const PRE_WHISPER_NORMALIZE_LUFS = -18;
export const MUSIC_DEFAULT_VOLUME_DB = -18;
export const MUSIC_DEFAULT_DUCKING_DB = -12;

let cachedCatalog = null;

export function resolveMusicCatalogPath(catalogPath = DEFAULT_CATALOG_PATH) {
  return catalogPath;
}

export function loadMusicCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  if (cachedCatalog && catalogPath === DEFAULT_CATALOG_PATH) {
    return cachedCatalog;
  }

  const resolved = resolveMusicCatalogPath(catalogPath);
  if (!fs.existsSync(resolved)) {
    return { version: "1.0", tracks: [] };
  }

  const catalog = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (catalogPath === DEFAULT_CATALOG_PATH) {
    cachedCatalog = catalog;
  }
  return catalog;
}

export function listTracks(catalogPath) {
  const catalog = loadMusicCatalog(catalogPath);
  return catalog.tracks ?? [];
}

export function resolveTrackFilePath(track, catalogPath = DEFAULT_CATALOG_PATH) {
  const resolvedCatalogPath = catalogPath ?? DEFAULT_CATALOG_PATH;
  const musicDir = resolvedCatalogPath === DEFAULT_CATALOG_PATH
    ? DEFAULT_MUSIC_DIR
    : path.dirname(resolveMusicCatalogPath(resolvedCatalogPath));
  return path.join(musicDir, track.fileName);
}

export function isTrackFileAvailable(track, catalogPath = DEFAULT_CATALOG_PATH) {
  if (!track?.fileName) {
    return false;
  }
  return fs.existsSync(resolveTrackFilePath(track, catalogPath));
}

/**
 * Resolve a catalog track by id; returns null when the audio file is missing on disk.
 */
export function resolveTrackById(trackId, { catalogPath = DEFAULT_CATALOG_PATH } = {}) {
  const track = listTracks(catalogPath).find((entry) => entry.trackId === trackId);
  if (!track) {
    return { track: null, reason: "track_not_in_catalog" };
  }
  if (!isTrackFileAvailable(track, catalogPath)) {
    return { track: null, reason: "track_file_missing" };
  }
  return { track, reason: null };
}

function listAvailableTracks(catalogPath) {
  return listTracks(catalogPath).filter((track) => isTrackFileAvailable(track, catalogPath));
}

function moodScore(trackMoods, targetMood) {
  const normalizedTarget = String(targetMood).toLowerCase();
  const moods = (trackMoods ?? []).map((m) => String(m).toLowerCase());
  if (moods.includes(normalizedTarget)) {
    return 1.0;
  }
  for (const mood of moods) {
    if (mood.includes(normalizedTarget) || normalizedTarget.includes(mood)) {
      return 0.75;
    }
  }
  return 0;
}

function bpmDistance(trackBpm, targetBpm) {
  if (!Number.isFinite(targetBpm) || !Number.isFinite(trackBpm)) {
    return 0;
  }
  return Math.abs(trackBpm - targetBpm);
}

/**
 * Pick best music bed track by mood and optional BPM proximity.
 */
export function pickByMood(mood, { bpm, tolerance = 20, catalogPath } = {}) {
  const tracks = listAvailableTracks(catalogPath);
  if (tracks.length === 0) {
    return null;
  }

  let best = null;
  let bestScore = -1;

  for (const track of tracks) {
    const moodMatch = moodScore(track.mood, mood);
    const bpmDist = bpmDistance(track.bpm, bpm);
    const bpmPenalty = Number.isFinite(bpm) && bpmDist > tolerance ? 0.25 : 0;
    const score = moodMatch - bpmPenalty - (bpmDist / 200);

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (!best || bestScore <= 0) {
    return tracks[0] ?? null;
  }

  return best;
}

/**
 * Compute music bed volume (dB) relative to voice target using track + measured voice LUFS.
 */
export function calculateMusicGain({
  voiceLufs,
  trackLufs,
  voiceTargetLufs = VOICE_TARGET_LUFS,
  baseVolumeDb = MUSIC_DEFAULT_VOLUME_DB,
} = {}) {
  if (!Number.isFinite(voiceLufs) || !Number.isFinite(trackLufs)) {
    return baseVolumeDb;
  }

  const voiceDelta = voiceTargetLufs - voiceLufs;
  const trackDelta = voiceTargetLufs - trackLufs;
  const adjustment = (voiceDelta + trackDelta) / 2;
  return Math.round((baseVolumeDb + adjustment) * 10) / 10;
}

export function summarizeMusicLibraryForIndex(catalogPath) {
  const tracks = listAvailableTracks(catalogPath);
  return {
    trackCount: tracks.length,
    tracks: tracks.map((track) => ({
      trackId: track.trackId,
      mood: track.mood ?? [],
      bpm: track.bpm,
    })),
  };
}

export function resetMusicCatalogCache() {
  cachedCatalog = null;
}
