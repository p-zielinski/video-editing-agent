import fs from "node:fs";
import path from "node:path";
import { probeDuration } from "./ffmpeg.js";
import { measureLoudness } from "./measure-loudness.js";
import { runPythonScript } from "./python-bridge.js";
import {
  buildTrackId,
  deriveEnergyLevel,
  deriveMoodTags,
  deriveUseCaseTags,
} from "./pixabay-music-page.js";
import { resetMusicCatalogCache } from "../editorial/music-library.js";

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function roundLufs(value) {
  return Math.round(value * 10) / 10;
}

export async function analyzeLocalMusicFile(filePath, { durationSec } = {}) {
  const resolvedDuration = durationSec ?? await probeDuration(filePath);

  const [loudness, audioAnalysis] = await Promise.all([
    measureLoudness(filePath).catch(() => null),
    runPythonScript("audio_analyze.py", {
      audioPath: filePath,
      durationSec: resolvedDuration,
    }).catch(() => null),
  ]);

  const beatsSec = (audioAnalysis?.beats ?? [])
    .map((beat) => roundSec(beat.timeSec))
    .filter((timeSec) => timeSec < resolvedDuration);

  return {
    durationSec: roundSec(resolvedDuration),
    bpm: audioAnalysis?.estimatedBpm ?? null,
    integratedLufs: loudness?.integratedLufs != null ? roundLufs(loudness.integratedLufs) : null,
    beatGrid: beatsSec.length
      ? {
        beatsSec,
        barSec: beatsSec.filter((_, index) => (index + 1) % 4 === 0),
        source: audioAnalysis?.analysisMode ?? "unknown",
      }
      : null,
  };
}

/**
 * @param {object} params
 */
export function buildCatalogEntry({
  fileName,
  parsedPage,
  analysis,
  trackId = null,
  title = null,
}) {
  const pixabay = parsedPage.pixabay ?? {};
  const resolvedTrackId = trackId ?? buildTrackId({
    pixabayId: parsedPage.pixabayId,
    fileName,
  });

  const entry = {
    trackId: resolvedTrackId,
    fileName,
    title: title ?? parsedPage.title,
    mood: deriveMoodTags(pixabay),
    useCase: deriveUseCaseTags(pixabay),
    energy: deriveEnergyLevel(pixabay),
    bpm: analysis.bpm ?? undefined,
    durationSec: analysis.durationSec,
    integratedLufs: analysis.integratedLufs ?? undefined,
  };

  if (Object.keys(pixabay).length > 0) {
    entry.pixabay = pixabay;
  }
  if (parsedPage.sourceUrl) {
    entry.sourceUrl = parsedPage.sourceUrl;
  }
  if (analysis.beatGrid) {
    entry.beatGrid = analysis.beatGrid;
  }

  return entry;
}

export function loadCatalog(catalogPath) {
  if (!fs.existsSync(catalogPath)) {
    return { version: "1.0", tracks: [] };
  }
  return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
}

export function upsertCatalogTrack(catalogPath, entry, { force = false } = {}) {
  const catalog = loadCatalog(catalogPath);
  const tracks = catalog.tracks ?? [];
  const existingIndex = tracks.findIndex((track) => track.trackId === entry.trackId);

  if (existingIndex >= 0 && !force) {
    throw new Error(
      `trackId "${entry.trackId}" już istnieje w katalogu. Użyj --force aby nadpisać.`,
    );
  }

  if (existingIndex >= 0) {
    tracks[existingIndex] = entry;
  } else {
    tracks.push(entry);
  }

  catalog.tracks = tracks;
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  resetMusicCatalogCache();
  return catalog;
}
