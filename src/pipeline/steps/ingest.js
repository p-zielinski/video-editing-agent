import fs from "node:fs";
import path from "node:path";
import {
  probeDuration,
  probeVideoDimensions,
  probeCreationTime,
} from "../../lib/ffmpeg.js";
import {
  SceneCatalogSchema,
  computeAspectRatio,
} from "../../schemas/scene-catalog.js";
import { writeJson, readJson, ARTIFACTS } from "../work-paths.js";
import { parseBatchContextFromUserContext, resolveDefaultSortBy } from "../../lib/input-mode.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
]);

const AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".m4a",
]);

const AUDIO_ONLY_PLACEHOLDER = {
  aspectRatio: "16:9",
  resolution: { w: 1920, h: 1080 },
};

export function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export function isAudioFile(fileName) {
  return AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export function isMediaFile(fileName) {
  return isVideoFile(fileName) || isAudioFile(fileName);
}

export function getMediaType(fileName) {
  if (isAudioFile(fileName)) {
    return "audio_only";
  }
  if (isVideoFile(fileName)) {
    return "video";
  }
  return null;
}

function sortClips(clips, sortBy = "mtime") {
  if (sortBy === "name") {
    return [...clips].sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  return [...clips].sort((a, b) => {
    const aTime = sortBy === "creation_time" ? (a.creationTime ?? a.mtime) : a.mtime;
    const bTime = sortBy === "creation_time" ? (b.creationTime ?? b.mtime) : b.mtime;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });
}

export async function scanInputFolder(inputDir, { dateFrom, dateTo, sortBy } = {}) {
  const entries = fs.readdirSync(inputDir, { withFileTypes: true });
  const clips = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isMediaFile(entry.name)) {
      continue;
    }

    const sourcePath = path.join(inputDir, entry.name);
    const stat = fs.statSync(sourcePath);
    const creationTime = (await probeCreationTime(sourcePath)) ?? stat.mtime.toISOString();

    if (dateFrom && new Date(creationTime) < new Date(dateFrom)) {
      continue;
    }
    if (dateTo && new Date(creationTime) > new Date(dateTo)) {
      continue;
    }

    clips.push({
      sourcePath,
      fileName: entry.name,
      mtime: stat.mtime.toISOString(),
      creationTime,
    });
  }

  if (!sortBy) {
    return clips;
  }

  return sortClips(clips, sortBy);
}

export function buildSceneCatalogFromDetection(batchId, clips, sceneDetectionByClip) {
  const catalogClips = clips.map((clip, index) => ({
    clipId: `clip${String(index + 1).padStart(2, "0")}`,
    sourcePath: clip.sourcePath,
    fileName: clip.fileName,
    durationSec: clip.durationSec,
    creationTime: clip.creationTime,
    sortIndex: index,
    aspectRatio: clip.aspectRatio,
    resolution: clip.resolution,
    ...(clip.mediaType ? { mediaType: clip.mediaType } : {}),
  }));

  const scenes = [];

  for (const clip of catalogClips) {
    const detected = sceneDetectionByClip.get(clip.clipId) ?? [];
    if (detected.length === 0) {
      scenes.push({
        sceneId: `${clip.clipId}_scene001`,
        clipId: clip.clipId,
        sourcePath: clip.sourcePath,
        startSec: 0,
        endSec: clip.durationSec,
        durationSec: clip.durationSec,
        aspectRatio: clip.aspectRatio,
        resolution: clip.resolution,
        ...(clip.mediaType ? { mediaType: clip.mediaType } : {}),
        hasSpeech: false,
      });
      continue;
    }

    detected.forEach((scene, sceneIndex) => {
      scenes.push({
        sceneId: `${clip.clipId}_scene${String(sceneIndex + 1).padStart(3, "0")}`,
        clipId: clip.clipId,
        sourcePath: clip.sourcePath,
        startSec: scene.startSec,
        endSec: scene.endSec,
        durationSec: scene.endSec - scene.startSec,
        aspectRatio: clip.aspectRatio,
        resolution: clip.resolution,
        ...(clip.mediaType ? { mediaType: clip.mediaType } : {}),
        hasSpeech: false,
        ...(scene.cutScore != null ? { cutScore: scene.cutScore } : {}),
      });
    });
  }

  return SceneCatalogSchema.parse({
    version: "1.0",
    batchId,
    clips: catalogClips,
    scenes,
  });
}

export async function runIngestStep({ inputDir, workDir, batchId, options = {}, force = false }) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.manifest, force)) {
    return {
      manifest: readJson(manifestPath),
      catalog: readJson(catalogPath),
    };
  }

  let rawClips = await scanInputFolder(inputDir, {
    ...options,
    sortBy: options.sortBy ?? undefined,
  });

  if (!options.sortBy) {
    const batchContext = parseBatchContextFromUserContext(options.userContext ?? "");
    rawClips = sortClips(rawClips, resolveDefaultSortBy(rawClips.length, batchContext));
  }

  if (rawClips.length === 0) {
    throw new Error(`Brak plików wideo lub audio w folderze: ${inputDir}`);
  }

  const clips = [];
  for (const raw of rawClips) {
    const durationSec = await probeDuration(raw.sourcePath);
    const mediaType = getMediaType(raw.fileName);

    if (mediaType === "audio_only") {
      clips.push({
        ...raw,
        durationSec,
        mediaType,
        aspectRatio: AUDIO_ONLY_PLACEHOLDER.aspectRatio,
        resolution: { ...AUDIO_ONLY_PLACEHOLDER.resolution },
      });
      continue;
    }

    const { width, height } = await probeVideoDimensions(raw.sourcePath);
    clips.push({
      ...raw,
      durationSec,
      mediaType: "video",
      aspectRatio: computeAspectRatio(width, height),
      resolution: { w: width, h: height },
    });
  }

  const manifest = {
    version: "1.0",
    batchId,
    inputDir: path.resolve(inputDir),
    userContext: options.userContext ?? "",
    clipCount: clips.length,
    totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
    createdAt: new Date().toISOString(),
    clips: clips.map((c) => ({
      fileName: c.fileName,
      sourcePath: c.sourcePath,
      durationSec: c.durationSec,
      creationTime: c.creationTime,
      ...(c.mediaType ? { mediaType: c.mediaType } : {}),
    })),
  };

  writeJson(path.join(workDir, ARTIFACTS.manifest), manifest);

  const sceneDetectionByClip = options.sceneDetectionByClip ?? new Map();
  const catalog = buildSceneCatalogFromDetection(batchId, clips, sceneDetectionByClip);
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), catalog);

  return { manifest, catalog };
}
