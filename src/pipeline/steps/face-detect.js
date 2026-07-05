import path from "node:path";
import fs from "node:fs";
import { runPythonScript } from "../../lib/python-bridge.js";
import { resolveClipContentHash } from "../../lib/clip-artifact-cache.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import {
  maybeUseGlobalClipCache,
  publishGlobalClipArtifact,
} from "../../lib/global-cache-step.js";
import { getGpuConcurrencyLimit, runWithConcurrency } from "../../lib/clip-concurrency.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

function shouldPublishSceneListArtifact({ useStub, items }) {
  if (!useStub) {
    return true;
  }
  return (items ?? []).length > 0;
}

export function loadCatalogForFaceDetect(workDir, catalog, timelineIndex) {
  if (catalog) {
    return catalog;
  }

  const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
  if (fs.existsSync(catalogPath)) {
    return readJson(catalogPath);
  }

  if (!timelineIndex) {
    const timelinePath = path.join(workDir, ARTIFACTS.timelineIndex);
    if (fs.existsSync(timelinePath)) {
      timelineIndex = readJson(timelinePath);
    } else {
      return { clips: [] };
    }
  }

  const clipIds = new Set();
  for (const clip of timelineIndex.clips ?? []) {
    clipIds.add(clip.clipId);
  }
  for (const scene of timelineIndex.scenes ?? []) {
    if (scene.clipId) {
      clipIds.add(scene.clipId);
    }
  }

  return {
    batchId: timelineIndex.batchId,
    clips: [...clipIds].map((clipId) => ({ clipId })),
  };
}

export async function processClipFaceDetect({
  workDir,
  clip,
  manifest = null,
  stub = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
  configFingerprint,
}) {
  const outPath = path.join(workDir, ARTIFACTS.faces(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    manifest,
    clipId: clip.clipId,
  })) {
    return readJson(outPath);
  }

  const resolvedFingerprint = configFingerprint ?? buildStepConfigFingerprint("faces", { stub });
  const sourceContentHash = await resolveClipContentHash(manifest, clip.clipId, clip.sourcePath);
  const cachedFaces = maybeUseGlobalClipCache({
    enabled: !globalCacheDisabled,
    step: "faces",
    contentHash: sourceContentHash,
    configFingerprint: resolvedFingerprint,
    clipId: clip.clipId,
    cacheRoot: globalCacheRoot,
    disabled: globalCacheDisabled,
  });

  if (cachedFaces) {
    const payload = sourceContentHash
      ? { ...cachedFaces, sourceContentHash }
      : cachedFaces;
    writeJson(outPath, payload);
    return payload;
  }

  const keyframesPath = path.join(workDir, ARTIFACTS.keyframes(clip.clipId));
  let frames = [];
  try {
    const keyframes = readJson(keyframesPath);
    frames = (keyframes.keyframes ?? [])
      .filter((kf) => kf.imagePath)
      .map((kf) => ({
        imagePath: path.join(workDir, kf.imagePath),
        timestampSec: kf.timestampSec,
        sceneId: kf.sceneId,
      }));
  } catch {
    frames = [];
  }

  const useStub = stub || frames.length === 0;
  const result = await runPythonScript("face_detect.py", {
    frames,
    stub: useStub,
  });

  const detections = result.detections ?? [];
  const payload = {
    version: "1.0",
    clipId: clip.clipId,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    detections,
  };

  writeJson(outPath, payload);

  if (
    sourceContentHash
    && shouldPublishSceneListArtifact({ useStub, items: detections })
  ) {
    publishGlobalClipArtifact({
      step: "faces",
      contentHash: sourceContentHash,
      configFingerprint: resolvedFingerprint,
      artifact: payload,
      cacheRoot: globalCacheRoot,
      disabled: globalCacheDisabled,
    });
  }

  return payload;
}

export async function runFaceDetectStep({
  workDir,
  catalog,
  timelineIndex,
  stub = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  const resolvedCatalog = loadCatalogForFaceDetect(workDir, catalog, timelineIndex);
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const configFingerprint = buildStepConfigFingerprint("faces", { stub });

  return runWithConcurrency(
    resolvedCatalog.clips,
    (clip) => processClipFaceDetect({
      workDir,
      clip,
      manifest,
      stub,
      force,
      globalCacheDisabled,
      globalCacheRoot,
      configFingerprint,
    }),
    { limit: getGpuConcurrencyLimit(), label: "face_detect" },
  );
}

export function collectFaceDetections(workDir, catalog, timelineIndex) {
  const resolvedCatalog = loadCatalogForFaceDetect(workDir, catalog, timelineIndex);
  const detections = [];
  for (const clip of resolvedCatalog.clips) {
    const facePath = path.join(workDir, ARTIFACTS.faces(clip.clipId));
    try {
      const data = readJson(facePath);
      detections.push(...(data.detections ?? []));
    } catch {
      // Face detect is optional — missing artifacts are OK.
    }
  }
  return detections;
}
