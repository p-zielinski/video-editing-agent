import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS, removeClipArtifact } from "../work-paths.js";
import { shouldUseCachedClipArtifact } from "../artifact-deps.js";
import { resolveClipContentHash } from "../../lib/clip-artifact-cache.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import {
  maybeUseGlobalClipCache,
  publishGlobalClipArtifact,
} from "../../lib/global-cache-step.js";
import { runWithConcurrency } from "../../lib/clip-concurrency.js";

const TWELVELABS_CONCURRENCY = 2;

function resolveSourcePath(clip, manifest) {
  if (clip.sourcePath) {
    return clip.sourcePath;
  }
  const manifestClip = (manifest?.clips ?? []).find((c) => c.clipId === clip.clipId);
  return manifestClip?.sourcePath ?? null;
}

function buildStubPayload(clipId, sourceContentHash) {
  return {
    version: "1.0",
    clipId,
    indexingStatus: "stub",
    ...(sourceContentHash ? { sourceContentHash } : {}),
    chapters: [],
    moments: [],
  };
}

function buildLivePayload(clipId, liveResult, sourceContentHash) {
  return {
    version: "1.1",
    clipId,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    twelveLabsAssetId: liveResult.twelveLabsAssetId,
    indexingStatus: liveResult.indexingStatus ?? "indexed",
    chapters: liveResult.chapters ?? [],
    moments: liveResult.moments ?? [],
    ...(liveResult.clipSummary ? { clipSummary: liveResult.clipSummary } : {}),
    ...(liveResult.gist ? { gist: liveResult.gist } : {}),
    ...(liveResult.editorial ? { editorial: liveResult.editorial } : {}),
  };
}

function canRefreshFromCachedAsset(cachedArtifact, sourceContentHash) {
  return Boolean(
    cachedArtifact?.twelveLabsAssetId
    && cachedArtifact?.sourceContentHash
    && sourceContentHash
    && cachedArtifact.sourceContentHash === sourceContentHash,
  );
}

async function runTwelveLabsLive({
  clip,
  sourcePath,
  apiKey,
  indexId,
  existingVideoId,
  skipUpload,
}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`TwelveLabs: brak pliku źródłowego dla ${clip.clipId}`);
  }
  const { indexVideoFromPath } = await import("../../lib/twelvelabs-client.js");
  return indexVideoFromPath({
    apiKey,
    indexId: indexId ?? process.env.TWELVELABS_INDEX_ID,
    sourcePath,
    clipId: clip.clipId,
    existingVideoId,
    skipUpload,
  });
}

export async function processClipTwelveLabs({
  workDir,
  clip,
  manifest = null,
  useStub,
  force = false,
  apiKey,
  configFingerprint,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  const outPath = path.join(workDir, ARTIFACTS.twelvelabs(clip.clipId));
  if (force) {
    removeClipArtifact(outPath);
  }
  if (shouldUseCachedClipArtifact(workDir, outPath, force, {
    manifest,
    clipId: clip.clipId,
    liveModeHints: { useStub, twelvelabsLive: !useStub },
  })) {
    return readJson(outPath);
  }

  const sourcePath = resolveSourcePath(clip, manifest);
  const sourceContentHash = await resolveClipContentHash(manifest, clip.clipId, sourcePath);
  const cachedTwelveLabs = maybeUseGlobalClipCache({
    enabled: !globalCacheDisabled,
    step: "twelvelabs",
    contentHash: sourceContentHash,
    configFingerprint,
    clipId: clip.clipId,
    cacheRoot: globalCacheRoot,
    disabled: globalCacheDisabled,
  });

  if (cachedTwelveLabs) {
    const payload = sourceContentHash
      ? { ...cachedTwelveLabs, sourceContentHash }
      : cachedTwelveLabs;
    writeJson(outPath, payload);
    return payload;
  }

  const cachedArtifact = fs.existsSync(outPath) ? readJson(outPath) : null;

  let payload;
  if (useStub) {
    payload = buildStubPayload(clip.clipId, sourceContentHash);
  } else {
    try {
      const refresh = canRefreshFromCachedAsset(cachedArtifact, sourceContentHash);
      const liveResult = await runTwelveLabsLive({
        clip,
        sourcePath,
        apiKey,
        existingVideoId: refresh ? cachedArtifact.twelveLabsAssetId : undefined,
        skipUpload: refresh,
      });
      payload = buildLivePayload(clip.clipId, liveResult, sourceContentHash);
    } catch (err) {
      console.warn(
        `TwelveLabs live API unavailable for ${clip.clipId}, falling back to stub: ${err.message}`,
      );
      payload = buildStubPayload(clip.clipId, sourceContentHash);
    }
  }

  writeJson(outPath, payload);

  if (sourceContentHash && payload.indexingStatus !== "stub") {
    publishGlobalClipArtifact({
      step: "twelvelabs",
      contentHash: sourceContentHash,
      configFingerprint,
      artifact: payload,
      cacheRoot: globalCacheRoot,
      disabled: globalCacheDisabled,
    });
  }

  return payload;
}

export async function runTwelveLabsStep({
  workDir,
  stub,
  force = false,
  apiKey,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = manifestPath && fs.existsSync(manifestPath)
    ? readJson(manifestPath)
    : null;

  const resolvedKey = apiKey ?? process.env.TWELVELABS_API_KEY;
  const useStub = stub ?? !resolvedKey;
  const configFingerprint = buildStepConfigFingerprint("twelvelabs", {
    useStub,
    twelvelabsLive: !useStub,
  });

  return runWithConcurrency(
    catalog.clips,
    (clip) => processClipTwelveLabs({
      workDir,
      clip,
      manifest,
      useStub,
      force,
      apiKey: resolvedKey,
      configFingerprint,
      globalCacheDisabled,
      globalCacheRoot,
    }),
    { limit: TWELVELABS_CONCURRENCY, label: "twelvelabs" },
  );
}
