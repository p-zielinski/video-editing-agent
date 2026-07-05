import fs from "node:fs";
import path from "node:path";
import { resolveClipContentHash } from "../../lib/clip-artifact-cache.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import {
  maybeUseGlobalClipCache,
  publishGlobalClipArtifact,
} from "../../lib/global-cache-step.js";
import { runPythonScript } from "../../lib/python-bridge.js";
import { getGpuConcurrencyLimit, runWithConcurrency } from "../../lib/clip-concurrency.js";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";

function shouldPublishSceneListArtifact({ useStub, items }) {
  if (!useStub) {
    return true;
  }
  return (items ?? []).length > 0;
}

export async function processClipVision({
  workDir,
  clip,
  manifest = null,
  stub = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
  configFingerprint,
}) {
  const outPath = path.join(workDir, ARTIFACTS.vision(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    manifest,
    clipId: clip.clipId,
  })) {
    return readJson(outPath);
  }

  const resolvedFingerprint = configFingerprint ?? buildStepConfigFingerprint("vision", { stub });
  const sourceContentHash = await resolveClipContentHash(manifest, clip.clipId, clip.sourcePath);
  const cachedVision = maybeUseGlobalClipCache({
    enabled: !globalCacheDisabled,
    step: "vision",
    contentHash: sourceContentHash,
    configFingerprint: resolvedFingerprint,
    clipId: clip.clipId,
    cacheRoot: globalCacheRoot,
    disabled: globalCacheDisabled,
  });

  if (cachedVision) {
    const payload = sourceContentHash
      ? { ...cachedVision, sourceContentHash }
      : cachedVision;
    writeJson(outPath, payload);
    return payload;
  }

  const keyframes = readJson(path.join(workDir, ARTIFACTS.keyframes(clip.clipId)));
  const frames = (keyframes.keyframes ?? [])
    .filter((kf) => kf.imagePath)
    .map((kf) => ({
      imagePath: path.join(workDir, kf.imagePath),
      timestampSec: kf.timestampSec,
      sceneId: kf.sceneId,
    }));

  const useStub = stub || frames.length === 0;
  const result = await runPythonScript("vision_qwen.py", {
    frames,
    stub: useStub,
  });

  const captions = result.captions ?? [];
  const payload = {
    version: "1.0",
    clipId: clip.clipId,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    captions,
  };

  writeJson(outPath, payload);

  if (
    sourceContentHash
    && shouldPublishSceneListArtifact({ useStub, items: captions })
  ) {
    publishGlobalClipArtifact({
      step: "vision",
      contentHash: sourceContentHash,
      configFingerprint: resolvedFingerprint,
      artifact: payload,
      cacheRoot: globalCacheRoot,
      disabled: globalCacheDisabled,
    });
  }

  return payload;
}

export async function processClipObjects({
  workDir,
  clip,
  manifest = null,
  stub = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
  configFingerprint,
}) {
  const outPath = path.join(workDir, ARTIFACTS.objects(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    manifest,
    clipId: clip.clipId,
  })) {
    return readJson(outPath);
  }

  const resolvedFingerprint = configFingerprint ?? buildStepConfigFingerprint("objects", { stub, enabled: true });
  const sourceContentHash = await resolveClipContentHash(manifest, clip.clipId, clip.sourcePath);
  const cachedObjects = maybeUseGlobalClipCache({
    enabled: !globalCacheDisabled,
    step: "objects",
    contentHash: sourceContentHash,
    configFingerprint: resolvedFingerprint,
    clipId: clip.clipId,
    cacheRoot: globalCacheRoot,
    disabled: globalCacheDisabled,
  });

  if (cachedObjects) {
    const payload = sourceContentHash
      ? { ...cachedObjects, sourceContentHash }
      : cachedObjects;
    writeJson(outPath, payload);
    return payload;
  }

  const keyframes = readJson(path.join(workDir, ARTIFACTS.keyframes(clip.clipId)));
  const frames = (keyframes.keyframes ?? [])
    .filter((kf) => kf.imagePath)
    .map((kf) => ({
      imagePath: path.join(workDir, kf.imagePath),
      timestampSec: kf.timestampSec,
      sceneId: kf.sceneId,
    }));

  const result = await runPythonScript("vision_florence.py", {
    frames,
    stub,
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
    && shouldPublishSceneListArtifact({ useStub: stub, items: detections })
  ) {
    publishGlobalClipArtifact({
      step: "objects",
      contentHash: sourceContentHash,
      configFingerprint: resolvedFingerprint,
      artifact: payload,
      cacheRoot: globalCacheRoot,
      disabled: globalCacheDisabled,
    });
  }

  return payload;
}

export async function runVisionStep({
  workDir,
  stub = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const configFingerprint = buildStepConfigFingerprint("vision", { stub });

  return runWithConcurrency(
    catalog.clips,
    (clip) => processClipVision({
      workDir,
      clip,
      manifest,
      stub,
      force,
      globalCacheDisabled,
      globalCacheRoot,
      configFingerprint,
    }),
    { limit: getGpuConcurrencyLimit(), label: "vision" },
  );
}

export async function runObjectsStep({
  workDir,
  stub = true,
  enabled = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  if (!enabled) {
    return [];
  }

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const configFingerprint = buildStepConfigFingerprint("objects", { stub, enabled });

  return runWithConcurrency(
    catalog.clips,
    (clip) => processClipObjects({
      workDir,
      clip,
      manifest,
      stub,
      force,
      globalCacheDisabled,
      globalCacheRoot,
      configFingerprint,
    }),
    { limit: getGpuConcurrencyLimit(), label: "objects" },
  );
}
