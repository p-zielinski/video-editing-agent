import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS } from "../pipeline/work-paths.js";
import { AI_HOOK_SEGMENT_ID } from "../lib/ai-video/types.js";

function findShortOutput(recipe) {
  return (recipe.outputs ?? []).find(
    (output) => output.format === "9:16" || output.outputKind === "short",
  ) ?? null;
}

function hasAiHookSegment(timeline = []) {
  return timeline.some(
    (segment) => segment.segmentRole === "ai_hook" || segment.segmentId === AI_HOOK_SEGMENT_ID,
  );
}

/**
 * Prepend AI-generated hook segment at the start of the short output.
 * @param {object} recipe
 * @param {object} aiVideoArtifact
 * @returns {boolean}
 */
export function enrichRecipeAiHook(recipe, aiVideoArtifact) {
  if (!recipe?.outputs?.length || !aiVideoArtifact) {
    return false;
  }

  if (aiVideoArtifact.status !== "succeeded") {
    return false;
  }

  const shortOutput = findShortOutput(recipe);
  if (!shortOutput?.timeline?.length) {
    return false;
  }

  if (hasAiHookSegment(shortOutput.timeline)) {
    return false;
  }

  const { clipId, sceneId, durationSec } = aiVideoArtifact;
  if (!clipId || !sceneId) {
    return false;
  }

  const followingSegment = shortOutput.timeline[0];
  const hookDuration = Math.min(durationSec ?? 5, 15);

  shortOutput.timeline.unshift({
    segmentId: AI_HOOK_SEGMENT_ID,
    segmentRole: "ai_hook",
    videoRef: { clipId, sceneId },
    audioRef: followingSegment.audioRef ?? followingSegment.videoRef,
    videoInSec: 0,
    videoOutSec: hookDuration,
    audioInSec: followingSegment.audioInSec ?? 0,
    audioOutSec: Math.min(
      (followingSegment.audioInSec ?? 0) + hookDuration,
      followingSegment.audioOutSec ?? hookDuration,
    ),
    audioPolicy: "from_next",
    overlapSec: 0,
    cuts: [],
    textOverlays: [],
    subtitles: { policy: "off" },
  });

  return true;
}

/**
 * Load AI video artifact when present.
 * @param {string} workDir
 * @returns {object | null}
 */
export function loadAiVideoArtifact(workDir) {
  const artifactPath = path.join(workDir, ARTIFACTS.aiVideo);
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Validate AI hook segment limits on recipe.
 * @param {object} recipe
 * @param {object} [batchContext]
 * @returns {object[]}
 */
export function validateAiVideoSegments(recipe, batchContext = {}) {
  const issues = [];
  const maxDuration = batchContext.aiVideoMaxDurationSec ?? 5;

  for (const output of recipe.outputs ?? []) {
    const aiHooks = (output.timeline ?? []).filter((seg) => seg.segmentRole === "ai_hook");
    if (aiHooks.length > 1) {
      issues.push({
        code: "V26-AIVIDEO-01",
        severity: "error",
        message: `Output ${output.outputId}: max 1 segment ai_hook (znaleziono ${aiHooks.length})`,
      });
    }

    for (const segment of aiHooks) {
      const duration = (segment.videoOutSec ?? 0) - (segment.videoInSec ?? 0);
      if (duration > maxDuration + 0.01) {
        issues.push({
          code: "V26-AIVIDEO-02",
          severity: "error",
          message: `Output ${output.outputId}: ai_hook duration ${duration.toFixed(1)}s > max ${maxDuration}s`,
        });
      }
    }
  }

  return issues;
}
