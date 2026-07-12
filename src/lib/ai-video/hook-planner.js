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
  const l1Scenes = Array.isArray(abstraction?.L1) ? abstraction.L1 : [];
  const l2Segments = Array.isArray(abstraction?.L2) ? abstraction.L2 : [];
  const sceneSummary = l1Scenes.find(
    (entry) => entry.sceneId === hookScene?.sceneId,
  );
  const segmentSummary = l2Segments.find(
    (entry) => entry.sceneIds?.includes(hookScene?.sceneId),
  );
  const storyContext = abstraction?.L3?.sessionSummary
    ?? abstraction?.L3?.narrativeArc
    ?? segmentSummary?.summary
    ?? segmentSummary?.synopsis
    ?? "";
  const topics = (sceneSummary?.topics ?? segmentSummary?.topics ?? [])
    .slice(0, 3)
    .join(", ");
  const visualTarget = sceneSummary?.summary ?? segmentSummary?.summary ?? "";
  const parts = [
    "Create a dynamic cinematic opening transition for a vertical short-form video",
    "Use smooth motivated camera motion and preserve subject identity, lighting, and composition between the supplied start and end frames",
  ];
  if (topics) {
    parts.push(`Themes: ${topics}`);
  }
  if (storyContext) {
    parts.push(`Story context: ${storyContext.slice(0, 300)}`);
  }
  if (visualTarget) {
    parts.push(`End naturally on this visual beat: ${visualTarget.slice(0, 240)}`);
  }
  parts.push("Single continuous shot, photorealistic, no captions, no logos, no generated text");
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
