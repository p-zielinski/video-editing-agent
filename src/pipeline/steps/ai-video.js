import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { generateAiHookForBatch } from "../../lib/ai-video/generate-hook.js";
import { resolveKlingVideoModel } from "../../lib/ai-video/kling-client.js";
import { createLogger } from "../../lib/logger.js";

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
    credentialsAvailable: Boolean(env.KLING_ACCESS_KEY && env.KLING_SECRET_KEY),
  };
}

export function canReuseAiVideoArtifact(artifact, execution) {
  return artifact?.status !== "failed"
    && artifact?.stub === execution.useStub
    && artifact?.model === execution.model;
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

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.aiVideo, force)) {
    const cached = readJson(outPath);
    if (canReuseAiVideoArtifact(cached, execution)) {
      return cached;
    }
  }

  if (!execution.useStub && !execution.credentialsAvailable) {
    const failed = {
      status: "failed",
      reason: "Missing KLING_ACCESS_KEY or KLING_SECRET_KEY; use --ai-video-stub explicitly for a placeholder",
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

    const artifact = {
      ...result,
      generatedAt: new Date().toISOString(),
      stub: execution.useStub,
      model: result.model ?? execution.model,
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
