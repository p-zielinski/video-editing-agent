import path from "node:path";
import fs from "node:fs";
import { extractFramePng, readImageBase64, normalizeHookVideo } from "./extract-frames.js";
import { generateStubHookVideo } from "./stub.js";
import { generateKlingHookVideo } from "./kling-client.js";
import { registerGeneratedHookClip } from "./register-clip.js";
import { planAiHook } from "./hook-planner.js";
import { DEFAULT_FORMAT_DIMENSIONS } from "../../render/render-config.js";

import { hasKlingCredentials, resolveKlingAccessKey } from "./kling-credentials.js";

/**
 * Run full AI hook generation pipeline for a batch work dir.
 */
export async function generateAiHookForBatch({
  workDir,
  batchContext,
  abstraction,
  timelineIndex,
  audioIndex,
  useStub = false,
  env = process.env,
  modelName,
}) {
  const plan = planAiHook({
    abstraction,
    timelineIndex,
    audioIndex,
    batchContext,
  });

  if (!plan) {
    return {
      status: "skipped",
      reason: "no_plan",
    };
  }

  if (!useStub && !hasKlingCredentials(env)) {
    throw new Error(
      "Missing KLING_ACCESS_KEY; set useStub explicitly for a placeholder",
    );
  }

  const generatedDir = path.join(workDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  const framesDir = path.join(generatedDir, "frames");
  const firstFramePath = path.join(framesDir, "first.png");
  const lastFramePath = path.join(framesDir, "last.png");
  const rawVideoPath = path.join(generatedDir, "ai_hook_raw.mp4");
  const finalVideoPath = path.join(generatedDir, "ai_hook_01.mp4");

  await extractFramePng({
    sourcePath: plan.sourcePath,
    timestampSec: plan.firstFrameSec,
    outputPath: firstFramePath,
  });
  await extractFramePng({
    sourcePath: plan.sourcePath,
    timestampSec: plan.lastFrameSec,
    outputPath: lastFramePath,
  });

  const dimensions = DEFAULT_FORMAT_DIMENSIONS["9:16"];
  let generation;

  if (useStub) {
    generation = await generateStubHookVideo({
      outputPath: finalVideoPath,
      durationSec: plan.durationSec,
      width: dimensions.width,
      height: dimensions.height,
    });
    generation.taskId = null;
    generation.model = "stub";
    generation.prompt = plan.prompt;
  } else {
    const klingResult = await generateKlingHookVideo({
      accessKey: resolveKlingAccessKey(env),
      prompt: plan.prompt,
      firstFrameBase64: readImageBase64(firstFramePath),
      lastFrameBase64: readImageBase64(lastFramePath),
      durationSec: plan.durationSec,
      aspectRatio: plan.aspectRatio,
      generateAudio: plan.generateAudio,
      rawOutputPath: rawVideoPath,
      modelName,
    });

    const normalized = await normalizeHookVideo({
      inputPath: klingResult.rawOutputPath,
      outputPath: finalVideoPath,
      width: dimensions.width,
      height: dimensions.height,
    });

    generation = {
      provider: "kling",
      model: klingResult.model,
      taskId: klingResult.taskId,
      outputPath: normalized.outputPath,
      durationSec: normalized.durationSec,
      prompt: plan.prompt,
    };
  }

  const registered = registerGeneratedHookClip(workDir, {
    sourcePath: generation.outputPath ?? finalVideoPath,
    fileName: path.basename(finalVideoPath),
    durationSec: generation.durationSec ?? plan.durationSec,
    aspectRatio: "9:16",
    resolution: { w: dimensions.width, h: dimensions.height },
    provider: generation.provider,
  });

  return {
    status: "succeeded",
    provider: generation.provider ?? "kling",
    model: generation.model ?? null,
    taskId: generation.taskId ?? null,
    plan,
    clipId: registered.clipId,
    sceneId: registered.sceneId,
    videoPath: generation.outputPath ?? finalVideoPath,
    durationSec: generation.durationSec ?? plan.durationSec,
    prompt: plan.prompt,
    frames: {
      firstFramePath,
      lastFramePath,
      firstFrameSec: plan.firstFrameSec,
      lastFrameSec: plan.lastFrameSec,
    },
  };
}
