import fs from "node:fs";
import path from "node:path";
import {
  resolveTrackById,
  resolveTrackFilePath,
} from "../editorial/music-library.js";

const SCENE_CATALOG_FILE = "00-scene-catalog.json";
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
    };
  }
  return clips;
}

function resolveMusicBed(recipe) {
  const bed = recipe?.audioMixPlan?.musicBed;
  if (!bed?.trackId) {
    return null;
  }

  const { track, reason } = resolveTrackById(bed.trackId);
  return {
    ...bed,
    track,
    trackFilePath: track ? resolveTrackFilePath(track) : null,
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
 *   sceneCatalog: object,
 * }}
 */
export function resolveRenderContext(workDir, recipe) {
  const sceneCatalogPath = path.join(workDir, SCENE_CATALOG_FILE);
  const sceneCatalog = JSON.parse(fs.readFileSync(sceneCatalogPath, "utf8"));

  return {
    batchId: sceneCatalog.batchId ?? recipe?.batchId ?? "",
    clips: mapClipsFromCatalog(sceneCatalog),
    wordIndexes: loadWordIndexes(workDir),
    musicBed: resolveMusicBed(recipe),
    sceneCatalog,
  };
}
