import { resolveBestHookScene } from "../../editorial/shorts-retention.js";
import { DEFAULT_AI_VIDEO_CONFIG } from "./types.js";

function deriveClipIdFromSceneId(sceneId) {
  const match = sceneId?.match(/^(clip\d+)_/);
  return match?.[1] ?? null;
}

function findScene(timelineIndex, sceneId) {
  return (timelineIndex?.scenes ?? []).find((scene) => scene.sceneId === sceneId) ?? null;
}

function findPreviousScene(timelineIndex, scene) {
  const scenes = (timelineIndex?.scenes ?? [])
    .filter((entry) => entry.clipId === scene.clipId)
    .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));
  const index = scenes.findIndex((entry) => entry.sceneId === scene.sceneId);
  if (index > 0) {
    return scenes[index - 1];
  }
  return null;
}

function buildPrompt(abstraction, hookScene) {
  const synopsis = abstraction?.L3?.synopsis
    ?? abstraction?.L2?.synopsis
    ?? abstraction?.L1?.synopsis
    ?? "";
  const topics = (abstraction?.L3?.topics ?? abstraction?.L1?.topics ?? [])
    .slice(0, 3)
    .join(", ");
  const sceneHint = hookScene?.sceneId ?? "highlight";
  const base = "Dynamic, cinematic transition with energy, smooth motion, vertical short-form hook";
  const parts = [base];
  if (topics) {
    parts.push(`theme: ${topics}`);
  }
  if (synopsis) {
    parts.push(synopsis.slice(0, 200));
  }
  parts.push(`leading into scene ${sceneHint}`);
  return parts.join(". ").slice(0, 2400);
}

/**
 * Plan AI hook generation from analysis artifacts.
 * @returns {null | object}
 */
export function planAiHook({
  abstraction,
  timelineIndex,
  audioIndex,
  batchContext = {},
}) {
  if (!batchContext.aiVideoEnabled) {
    return null;
  }

  const targetOutputs = batchContext.aiVideoTargetOutputs ?? DEFAULT_AI_VIDEO_CONFIG.targetOutputs ?? ["9:16"];
  if (!targetOutputs.includes("9:16")) {
    return null;
  }

  const { sceneId: hookSceneId, source } = resolveBestHookScene(abstraction, timelineIndex, audioIndex);
  if (!hookSceneId) {
    return null;
  }

  const hookScene = findScene(timelineIndex, hookSceneId);
  if (!hookScene?.sourcePath) {
    return null;
  }

  const previousScene = findPreviousScene(timelineIndex, hookScene);
  const hookStart = hookScene.startSec ?? 0;
  const firstFrameSec = previousScene
    ? Math.max(previousScene.endSec - 0.25, previousScene.startSec ?? 0)
    : Math.max(0, hookStart - 0.5);
  const lastFrameSec = hookStart;

  const maxDurationSec = Math.min(
    batchContext.aiVideoMaxDurationSec ?? DEFAULT_AI_VIDEO_CONFIG.maxDurationSec,
    15,
  );

  return {
    hookSceneId,
    hookSource: source,
    hookClipId: deriveClipIdFromSceneId(hookSceneId),
    sourcePath: hookScene.sourcePath,
    firstFrameSec,
    lastFrameSec,
    durationSec: maxDurationSec,
    aspectRatio: "9:16",
    mode: "pro",
    generateAudio: batchContext.aiVideoGenerateAudio === true,
    prompt: buildPrompt(abstraction, hookScene),
  };
}
