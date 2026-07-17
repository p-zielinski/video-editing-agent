import fs from "node:fs";
import path from "node:path";
import {
  resolveTrackById,
  resolveTrackFilePath,
} from "../editorial/music-library.js";
import { ARTIFACTS } from "../pipeline/work-paths.js";

const SCENE_CATALOG_FILE = "00-scene-catalog.json";
const SPATIAL_INDEX_FILE = "05c-spatial-index.json";
const WORDS_FILE_PATTERN = /^01-words-(.+)\.json$/;

function loadWordIndexes(workDir) {
  const wordIndexes = {};
  for (const entry of fs.readdirSync(workDir)) {
    const match = entry.match(WORDS_FILE_PATTERN);
    if (!match) {
      continue;
    }
    const clipId = match[1];
    const filePath = path.join(workDir, entry);
    wordIndexes[clipId] = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return wordIndexes;
}

function mapClipsFromCatalog(sceneCatalog) {
  const clips = {};
  for (const clip of sceneCatalog.clips ?? []) {
    clips[clip.clipId] = {
      sourcePath: clip.sourcePath,
      fileName: clip.fileName,
      resolution: clip.resolution ?? null,
      ...(clip.mediaType ? { mediaType: clip.mediaType } : {}),
    };
  }
  return clips;
}

function validateClipSourcePaths(clips) {
  for (const [clipId, clip] of Object.entries(clips)) {
    if (!clip.sourcePath || !fs.existsSync(clip.sourcePath)) {
      throw new Error(
        `Brak pliku źródłowego dla clipId ${clipId}: ${clip.sourcePath ?? "(brak ścieżki)"}`,
      );
    }
  }
}

function resolveWorkDirMusicCatalogPath(workDir) {
  const catalogPath = path.join(workDir, "music", "catalog.json");
  return fs.existsSync(catalogPath) ? catalogPath : null;
}

function resolveMusicBed(workDir, recipe) {
  const bed = recipe?.audioMixPlan?.musicBed;
  if (!bed?.trackId) {
    return null;
  }

  const catalogPath = resolveWorkDirMusicCatalogPath(workDir);
  const resolveOptions = catalogPath ? { catalogPath } : {};
  const { track, reason } = resolveTrackById(bed.trackId, resolveOptions);
  return {
    ...bed,
    track,
    trackFilePath: track ? resolveTrackFilePath(track, catalogPath) : null,
    resolveReason: reason,
  };
}

/**
 * Load batch artifacts from workDir and resolve clip paths, word indexes, and music bed.
 *
 * @param {string} workDir - batch work directory (e.g. output/.work/<batchId>)
 * @param {object} recipe - EditRecipe v2.x
 * @returns {{
 *   batchId: string,
 *   clips: Record<string, { sourcePath: string, fileName: string, resolution: object|null }>,
 *   wordIndexes: Record<string, object>,
 *   musicBed: object|null,
 *   spatialIndex: object|null,
 *   sceneCatalog: object,
 * }}
 */
function loadSpatialIndex(workDir) {
  const spatialPath = path.join(workDir, SPATIAL_INDEX_FILE);
  if (!fs.existsSync(spatialPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(spatialPath, "utf8"));
}

function loadAudioIndex(workDir) {
  const audioIndexPath = path.join(workDir, ARTIFACTS.audioIndex);
  if (!fs.existsSync(audioIndexPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(audioIndexPath, "utf8"));
}

function loadAudioEnhancementIndex(workDir) {
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

function buildEnhancedAudioPaths(workDir, enhancementIndex) {
  const paths = {};
  for (const entry of enhancementIndex?.clips ?? []) {
    if ((entry.status === "succeeded" || entry.status === "stubbed") && entry.outputPath) {
      paths[entry.clipId] = path.resolve(workDir, entry.outputPath);
    }
  }
  return paths;
}

export function resolveRenderContext(workDir, recipe) {
  const sceneCatalogPath = path.join(workDir, SCENE_CATALOG_FILE);
  const sceneCatalog = JSON.parse(fs.readFileSync(sceneCatalogPath, "utf8"));
  const clips = mapClipsFromCatalog(sceneCatalog);
  validateClipSourcePaths(clips);

  return {
    batchId: sceneCatalog.batchId ?? recipe?.batchId ?? "",
    clips,
    wordIndexes: loadWordIndexes(workDir),
    musicBed: resolveMusicBed(workDir, recipe),
    spatialIndex: loadSpatialIndex(workDir),
    sceneCatalog,
    audioIndex: loadAudioIndex(workDir),
    enhancedAudioPaths: buildEnhancedAudioPaths(workDir, loadAudioEnhancementIndex(workDir)),
  };
}
