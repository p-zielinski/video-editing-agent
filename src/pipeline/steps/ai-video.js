import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { generateAiHookForBatch } from "../../lib/ai-video/generate-hook.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("ai-video");

export function shouldRunAiVideoStep(batchContext = {}) {
  return batchContext.aiVideoEnabled === true;
}

/**
 * @param {object} params
 * @param {string} params.workDir
 * @param {object} [params.batchContext]
 * @param {boolean} [params.force]
 * @param {boolean} [params.useStub]
 */
export async function runAiVideoStep({
  workDir,
  batchContext = {},
  force = false,
  useStub = false,
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

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.aiVideo, force)) {
    return readJson(outPath);
  }

  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  let audioIndex = { clips: [] };
  const audioIndexPath = path.join(workDir, ARTIFACTS.audioIndex);
  if (fs.existsSync(audioIndexPath)) {
    audioIndex = readJson(audioIndexPath);
  }

  const resolvedStub = useStub
    || process.env.AI_VIDEO_STUB === "1"
    || (!process.env.KLING_ACCESS_KEY || !process.env.KLING_SECRET_KEY);

  if (resolvedStub && batchContext.aiVideoEnabled) {
    log.warn("AI video stub — brak KLING_* lub --ai-video-stub");
  }

  try {
    const result = await generateAiHookForBatch({
      workDir,
      batchContext,
      abstraction,
      timelineIndex,
      audioIndex,
      useStub: resolvedStub,
    });

    const artifact = {
      ...result,
      generatedAt: new Date().toISOString(),
      stub: resolvedStub,
    };
    writeJson(outPath, artifact);
    return artifact;
  } catch (error) {
    const failed = {
      status: "failed",
      reason: error.message,
      generatedAt: new Date().toISOString(),
      stub: resolvedStub,
    };
    writeJson(outPath, failed);
    log.warn(`AI video generation failed: ${error.message}`);
    return failed;
  }
}
