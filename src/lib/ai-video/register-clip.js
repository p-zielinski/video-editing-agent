import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS } from "../../pipeline/work-paths.js";
import { AI_HOOK_CLIP_ID, AI_HOOK_SCENE_ID } from "./types.js";
import { computeSourceContentHashSync } from "../source-hash.js";

function nextAiClipId(existingClipIds) {
  if (!existingClipIds.includes(AI_HOOK_CLIP_ID)) {
    return AI_HOOK_CLIP_ID;
  }
  let index = 2;
  while (existingClipIds.includes(`ai_hook_${String(index).padStart(2, "0")}`)) {
    index += 1;
  }
  return `ai_hook_${String(index).padStart(2, "0")}`;
}

/**
 * Register generated AI hook clip in manifest, scene catalog, and clip registry.
 */
export function registerGeneratedHookClip(workDir, {
  clipId = AI_HOOK_CLIP_ID,
  sceneId = AI_HOOK_SCENE_ID,
  sourcePath,
  fileName,
  durationSec,
  aspectRatio = "9:16",
  resolution = { w: 1080, h: 1920 },
  provider = "kling",
}) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
  const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);

  const manifest = readJson(manifestPath);
  const catalog = readJson(catalogPath);
  const registryData = fs.existsSync(registryPath) ? readJson(registryPath) : { clipRegistry: [] };
  const clipRegistry = registryData.clipRegistry ?? registryData;

  const existingIds = (catalog.clips ?? []).map((clip) => clip.clipId);
  const effectiveClipId = clipId || nextAiClipId(existingIds);
  const effectiveSceneId = sceneId || `${effectiveClipId}_scene001`;
  const effectiveFileName = fileName ?? path.basename(sourcePath);
  const contentHash = computeSourceContentHashSync(sourcePath);

  const clipEntry = {
    clipId: effectiveClipId,
    sourcePath,
    fileName: effectiveFileName,
    durationSec,
    sortIndex: (catalog.clips?.length ?? 0),
    aspectRatio,
    resolution,
    mediaType: "video",
    generated: true,
    provider,
  };

  const sceneEntry = {
    sceneId: effectiveSceneId,
    clipId: effectiveClipId,
    sourcePath,
    startSec: 0,
    endSec: durationSec,
    durationSec,
    aspectRatio,
    resolution,
    mediaType: "video",
    hasSpeech: false,
  };

  catalog.clips = [...(catalog.clips ?? []).filter((c) => c.clipId !== effectiveClipId), clipEntry];
  catalog.scenes = [...(catalog.scenes ?? []).filter((s) => s.sceneId !== effectiveSceneId), sceneEntry];
  writeJson(catalogPath, catalog);

  if (Array.isArray(manifest.clips)) {
    manifest.clips = [...manifest.clips.filter((c) => c.clipId !== effectiveClipId), {
      clipId: effectiveClipId,
      sourcePath,
      fileName: effectiveFileName,
      ...(contentHash ? { contentHash } : {}),
    }];
  }
  writeJson(manifestPath, manifest);

  const registryEntry = {
    clipId: effectiveClipId,
    fileName: effectiveFileName,
    durationSec,
    sortIndex: clipEntry.sortIndex,
    clipRole: "ai_generated",
    roleConfidence: 1,
    roleSource: "ai_video",
    hasSpeech: false,
    speechWordCount: 0,
    visualSummary: "AI-generated short hook (Kling)",
    mediaType: "video",
  };

  const updatedRegistry = [
    ...clipRegistry.filter((entry) => entry.clipId !== effectiveClipId),
    registryEntry,
  ].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));

  writeJson(registryPath, { clipRegistry: updatedRegistry });

  return {
    clipId: effectiveClipId,
    sceneId: effectiveSceneId,
    clipEntry,
    sceneEntry,
    registryEntry,
  };
}
