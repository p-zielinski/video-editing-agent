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
import { probeDuration } from "../../lib/ffmpeg.js";
import {
  resolveTwelveLabsMinDurationSec,
} from "../../lib/twelvelabs-upload-prep.js";
import { analyzeShortClipWithGpt } from "../../lib/twelvelabs-short-analysis.js";
import { isThinTwelveLabsInsights } from "../../lib/twelvelabs-client.js";

const TWELVELABS_CONCURRENCY = 2;

function resolveSourcePath(clip, manifest) {
  if (clip.sourcePath) {
    return clip.sourcePath;
  }
  const manifestClip = (manifest?.clips ?? []).find((c) => c.clipId === clip.clipId);
  return manifestClip?.sourcePath ?? null;
}

export async function resolveClipDurationSec(clip, manifest, sourcePath) {
  if (Number.isFinite(clip?.durationSec) && clip.durationSec > 0) {
    return clip.durationSec;
  }
  const manifestClip = (manifest?.clips ?? []).find((c) => c.clipId === clip.clipId);
  if (Number.isFinite(manifestClip?.durationSec) && manifestClip.durationSec > 0) {
    return manifestClip.durationSec;
  }
  if (sourcePath && fs.existsSync(sourcePath)) {
    try {
      return await probeDuration(sourcePath);
    } catch {
      return null;
    }
  }
  return null;
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
    ...(liveResult.chunkCount != null ? { chunkCount: liveResult.chunkCount } : {}),
    ...(liveResult.chunkVideoIds ? { chunkVideoIds: liveResult.chunkVideoIds } : {}),
    ...(liveResult.clipSummary ? { clipSummary: liveResult.clipSummary } : {}),
    ...(liveResult.gist ? { gist: liveResult.gist } : {}),
    ...(liveResult.editorial ? { editorial: liveResult.editorial } : {}),
  };
}

function buildFrameAnalysisPayload(clipId, analysis, sourceContentHash) {
  return {
    version: "1.1",
    clipId,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    indexingStatus: "frame_analysis",
    chapters: analysis.chapters ?? [],
    moments: analysis.moments ?? [],
    ...(analysis.clipSummary ? { clipSummary: analysis.clipSummary } : {}),
    ...(analysis.editorial ? { editorial: analysis.editorial } : {}),
  };
}

function canRefreshFromCachedAsset(cachedArtifact, sourceContentHash) {
  return Boolean(
    cachedArtifact?.twelveLabsAssetId
    && cachedArtifact?.sourceContentHash
    && sourceContentHash
    && cachedArtifact.sourceContentHash === sourceContentHash
    && (cachedArtifact.indexingStatus === "indexed" || cachedArtifact.indexingStatus === "chunked"),
  );
}

function canPublishGlobal(payload) {
  return payload?.indexingStatus
    && payload.indexingStatus !== "stub";
}

async function recoverThinTwelveLabsInsights({
  clip,
  sourcePath,
  durationSec,
  payload,
  workDir,
  openaiApiKey,
  dailyQuotaTracker,
  gptUsageTracker,
  batchId,
  analyzeShortClipWithGptFn,
}) {
  if (!isThinTwelveLabsInsights(payload)) {
    return payload;
  }

  try {
    const analysis = await analyzeShortClipWithGptFn({
      workDir,
      clip,
      sourcePath,
      durationSec,
      openaiApiKey,
      dailyQuotaTracker,
      gptUsageTracker,
      batchId,
    });
    return {
      ...buildFrameAnalysisPayload(clip.clipId, analysis, payload.sourceContentHash),
      indexingStatus: "frame_analysis_fallback",
      twelveLabsAssetId: payload.twelveLabsAssetId,
      thinInsightsRecovered: true,
    };
  } catch (err) {
    console.warn(
      `TwelveLabs thin insights for ${clip.clipId} — GPT fallback failed: ${err.message}`,
    );
    return {
      ...payload,
      thinInsights: true,
    };
  }
}

async function runTwelveLabsLive({
  clip,
  sourcePath,
  workDir,
  durationSec,
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
    workDir,
    durationSec,
  });
}

export async function processClipTwelveLabs({
  workDir,
  clip,
  manifest = null,
  useStub,
  force = false,
  apiKey,
  openaiApiKey = process.env.OPENAI_API_KEY,
  configFingerprint,
  globalCacheDisabled = false,
  globalCacheRoot,
  dailyQuotaTracker = null,
  gptUsageTracker = null,
  batchId = null,
  analyzeShortClipWithGptFn = analyzeShortClipWithGpt,
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
  const durationSec = await resolveClipDurationSec(clip, manifest, sourcePath);
  const minDurationSec = resolveTwelveLabsMinDurationSec();

  let payload;
  if (useStub) {
    payload = buildStubPayload(clip.clipId, sourceContentHash);
  } else if (
    durationSec != null
    && durationSec < minDurationSec
  ) {
    try {
      const analysis = await analyzeShortClipWithGptFn({
        workDir,
        clip,
        sourcePath,
        durationSec,
        openaiApiKey,
        dailyQuotaTracker,
        gptUsageTracker,
        batchId,
      });
      payload = buildFrameAnalysisPayload(clip.clipId, analysis, sourceContentHash);
    } catch (err) {
      console.warn(
        `TwelveLabs short-clip GPT unavailable for ${clip.clipId}, falling back to stub: ${err.message}`,
      );
      payload = buildStubPayload(clip.clipId, sourceContentHash);
    }
  } else {
    try {
      const refresh = canRefreshFromCachedAsset(cachedArtifact, sourceContentHash);
      const liveResult = await runTwelveLabsLive({
        clip,
        sourcePath,
        workDir,
        durationSec,
        apiKey,
        existingVideoId: refresh ? cachedArtifact.twelveLabsAssetId : undefined,
        skipUpload: refresh,
      });
      payload = buildLivePayload(clip.clipId, liveResult, sourceContentHash);
      if (sourcePath && fs.existsSync(sourcePath)) {
        payload = await recoverThinTwelveLabsInsights({
          clip,
          sourcePath,
          durationSec,
          payload,
          workDir,
          openaiApiKey,
          dailyQuotaTracker,
          gptUsageTracker,
          batchId,
          analyzeShortClipWithGptFn,
        });
      } else if (isThinTwelveLabsInsights(payload)) {
        payload = { ...payload, thinInsights: true };
      }
    } catch (err) {
      console.warn(
        `TwelveLabs live API unavailable for ${clip.clipId}, falling back to stub: ${err.message}`,
      );
      payload = buildStubPayload(clip.clipId, sourceContentHash);
    }
  }

  writeJson(outPath, payload);

  if (sourceContentHash && canPublishGlobal(payload)) {
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
  openaiApiKey,
  globalCacheDisabled = false,
  globalCacheRoot,
  dailyQuotaTracker = null,
  gptUsageTracker = null,
  batchId = null,
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
      openaiApiKey: openaiApiKey ?? process.env.OPENAI_API_KEY,
      configFingerprint,
      globalCacheDisabled,
      globalCacheRoot,
      dailyQuotaTracker,
      gptUsageTracker,
      batchId,
    }),
    { limit: TWELVELABS_CONCURRENCY, label: "twelvelabs" },
  );
}
