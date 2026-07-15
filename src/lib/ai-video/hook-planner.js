import { DEFAULT_AI_VIDEO_CONFIG } from "./types.js";
import { compileHookPrompt } from "./hook-prompt-compiler.js";
import { selectAiHookScene } from "./ai-hook-scene.js";

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

function buildContinuityContext(abstraction, previousScene) {
  if (!previousScene) {
    return {};
  }
  const l1 = (abstraction?.L1 ?? []).find(
    (entry) => entry.sceneId === previousScene.sceneId,
  );
  return {
    previousSceneId: previousScene.sceneId,
    previousSceneSummary: l1?.summary ?? null,
  };
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

  const selection = selectAiHookScene(abstraction, timelineIndex, audioIndex);
  if (!selection?.sceneId) {
    return null;
  }

  const hookSceneId = selection.sceneId;
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

  const hookCreativeBrief = abstraction?.L3?.hookCreativeBrief ?? null;
  const continuity = buildContinuityContext(abstraction, previousScene);

  return {
    hookSceneId,
    hookSource: selection.source,
    hookSelection: selection.selection,
    hookCreativeBrief,
    hookClipId: deriveClipIdFromSceneId(hookSceneId),
    sourcePath: hookScene.sourcePath,
    firstFrameSec,
    lastFrameSec,
    durationSec: maxDurationSec,
    aspectRatio: "9:16",
    mode: "pro",
    generateAudio: batchContext.aiVideoGenerateAudio === true,
    prompt: compileHookPrompt({
      brief: hookCreativeBrief,
      abstraction,
      hookScene,
      continuity,
    }),
  };
}
