import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { generateAiHookForBatch } from "../../lib/ai-video/generate-hook.js";
import { hasKlingCredentials } from "../../lib/ai-video/kling-credentials.js";
import { resolveKlingVideoModel } from "../../lib/ai-video/kling-client.js";
import { createLogger } from "../../lib/logger.js";
import { processClipTwelveLabs } from "./twelvelabs.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";

const log = createLogger("ai-video");

export function shouldRunAiVideoStep(batchContext = {}) {
  return batchContext.aiVideoEnabled === true;
}

export function resolveAiVideoExecution({
  useStub = false,
  env = process.env,
} = {}) {
  const resolvedStub = useStub || env.AI_VIDEO_STUB === "1";
  return {
    useStub: resolvedStub,
    model: resolvedStub ? "stub" : resolveKlingVideoModel(env),
    credentialsAvailable: hasKlingCredentials(env),
  };
}

export function canReuseAiVideoArtifact(artifact, execution, {
  twelveLabsMode,
} = {}) {
  const baseMatch = artifact?.status !== "failed"
    && artifact?.stub === execution.useStub
    && artifact?.model === execution.model;
  if (!baseMatch) {
    return false;
  }
  if (!twelveLabsMode) {
    return true;
  }
  if (artifact?.twelveLabsAnalysis?.mode !== twelveLabsMode) {
    return false;
  }
  return twelveLabsMode !== "live"
    || artifact?.twelveLabsAnalysis?.status === "succeeded";
}

export async function analyzeGeneratedHookWithTwelveLabs({
  workDir,
  generated,
  enabled = true,
  useStub = false,
  apiKey,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
  processClip = processClipTwelveLabs,
}) {
  const mode = !enabled ? "disabled" : (useStub ? "stub" : "live");
  if (!enabled) {
    return { status: "disabled", mode, reason: "twelvelabs_disabled" };
  }
  if (generated?.status !== "succeeded" || generated?.provider !== "kling") {
    return { status: "skipped", mode, reason: "not_a_generated_kling_hook" };
  }

  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const configFingerprint = buildStepConfigFingerprint("twelvelabs", {
    useStub,
    twelvelabsLive: !useStub,
  });

  try {
    const result = await processClip({
      workDir,
      clip: {
        clipId: generated.clipId,
        sourcePath: generated.videoPath,
      },
      manifest,
      useStub,
      force,
      apiKey,
      configFingerprint,
      globalCacheDisabled,
      globalCacheRoot,
    });
    if (result?.indexingStatus === "stub") {
      return {
        status: "unavailable",
        mode,
        reason: "twelvelabs_stub",
        indexingStatus: "stub",
      };
    }
    return {
      status: "succeeded",
      mode,
      indexingStatus: result?.indexingStatus ?? "indexed",
      ...(result?.clipSummary ? { clipSummary: result.clipSummary } : {}),
      ...(result?.gist ? { gist: result.gist } : {}),
      ...(result?.editorial ? { editorial: result.editorial } : {}),
    };
  } catch (error) {
    return {
      status: "unavailable",
      mode,
      reason: error.message,
    };
  }
}

/**
 * @param {object} params
 * @param {string} params.workDir
 * @param {object} [params.batchContext]
 * @param {boolean} [params.force]
 * @param {boolean} [params.useStub]
 * @param {NodeJS.ProcessEnv|object} [params.env]
 */
export async function runAiVideoStep({
  workDir,
  batchContext = {},
  force = false,
  useStub = false,
  env = process.env,
  analyzeWithTwelveLabs = true,
  twelveLabsStub = !env.TWELVELABS_API_KEY,
  twelveLabsApiKey = env.TWELVELABS_API_KEY,
  globalCacheDisabled = false,
  globalCacheRoot,
}) {
  const outPath = path.join(workDir, ARTIFACTS.aiVideo);

  if (!shouldRunAiVideoStep(batchContext)) {
    const skipped = {
      status: "disabled",
      reason: "aiVideoEnabled is false",
      generatedAt: new Date().toISOString(),
    };
    writeJson(outPath, skipped);
    return skipped;
  }

  const execution = resolveAiVideoExecution({ useStub, env });
  const twelveLabsMode = !analyzeWithTwelveLabs
    ? "disabled"
    : (twelveLabsStub ? "stub" : "live");

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.aiVideo, force)) {
    const cached = readJson(outPath);
    if (canReuseAiVideoArtifact(cached, execution, { twelveLabsMode })) {
      return cached;
    }
    if (canReuseAiVideoArtifact(cached, execution)) {
      const twelveLabsAnalysis = await analyzeGeneratedHookWithTwelveLabs({
        workDir,
        generated: cached,
        enabled: analyzeWithTwelveLabs,
        useStub: twelveLabsStub,
        apiKey: twelveLabsApiKey,
        force: false,
        globalCacheDisabled,
        globalCacheRoot,
      });
      const refreshed = {
        ...cached,
        twelveLabsAnalysis,
        analysisUpdatedAt: new Date().toISOString(),
      };
      writeJson(outPath, refreshed);
      return refreshed;
    }
  }

  if (!execution.useStub && !execution.credentialsAvailable) {
    const failed = {
      status: "failed",
      reason: "Missing KLING_ACCESS_KEY; use --ai-video-stub explicitly for a placeholder",
      generatedAt: new Date().toISOString(),
      stub: false,
      model: execution.model,
    };
    writeJson(outPath, failed);
    log.warn(failed.reason);
    return failed;
  }

  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  let audioIndex = { clips: [] };
  const audioIndexPath = path.join(workDir, ARTIFACTS.audioIndex);
  if (fs.existsSync(audioIndexPath)) {
    audioIndex = readJson(audioIndexPath);
  }

  if (execution.useStub) {
    log.warn("AI video stub — jawnie włączony placeholder bez wywołania Kling API");
  }

  try {
    const result = await generateAiHookForBatch({
      workDir,
      batchContext,
      abstraction,
      timelineIndex,
      audioIndex,
      useStub: execution.useStub,
      env,
      modelName: execution.model,
    });

    const twelveLabsAnalysis = await analyzeGeneratedHookWithTwelveLabs({
      workDir,
      generated: result,
      enabled: analyzeWithTwelveLabs,
      useStub: twelveLabsStub,
      apiKey: twelveLabsApiKey,
      force,
      globalCacheDisabled,
      globalCacheRoot,
    });
    const artifact = {
      ...result,
      generatedAt: new Date().toISOString(),
      stub: execution.useStub,
      model: result.model ?? execution.model,
      twelveLabsAnalysis,
    };
    writeJson(outPath, artifact);
    return artifact;
  } catch (error) {
    const failed = {
      status: "failed",
      reason: error.message,
      generatedAt: new Date().toISOString(),
      stub: execution.useStub,
      model: execution.model,
    };
    writeJson(outPath, failed);
    log.warn(`AI video generation failed: ${error.message}`);
    return failed;
  }
}
