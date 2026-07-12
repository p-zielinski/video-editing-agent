import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeAiHook,
  validateAiVideoSegments,
} from "./ai-hook-enrich.js";
import { AI_HOOK_SEGMENT_ID } from "../lib/ai-video/types.js";

describe("enrichRecipeAiHook", () => {
  const aiArtifact = {
    status: "succeeded",
    clipId: "ai_hook_01",
    sceneId: "ai_hook_01_scene001",
    durationSec: 5,
  };

  it("prepends ai_hook segment on short output", () => {
    const recipe = {
      outputs: [{
        outputId: "vertical_main",
        format: "9:16",
        outputKind: "short",
        timeline: [{
          segmentId: "seg_main",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 10,
          videoOutSec: 30,
          audioInSec: 10,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
        }],
      }],
    };

    const changed = enrichRecipeAiHook(recipe, aiArtifact);
    assert.equal(changed, true);
    assert.equal(recipe.outputs[0].timeline[0].segmentRole, "ai_hook");
    assert.equal(recipe.outputs[0].timeline[0].segmentId, AI_HOOK_SEGMENT_ID);
    assert.equal(recipe.outputs[0].timeline[0].audioPolicy, "from_next");
  });

  it("skips when artifact not succeeded", () => {
    const recipe = { outputs: [{ outputId: "s", format: "9:16", timeline: [] }] };
    assert.equal(enrichRecipeAiHook(recipe, { status: "failed" }), false);
  });

  it("acts as fallback only when Director has not already used the generated clip", () => {
    const recipe = {
      outputs: [{
        outputId: "vertical_main",
        format: "9:16",
        timeline: [{
          segmentId: "director_hook",
          segmentRole: "broll",
          videoRef: {
            clipId: "ai_hook_01",
            sceneId: "ai_hook_01_scene001",
          },
        }],
      }],
    };

    assert.equal(enrichRecipeAiHook(recipe, aiArtifact), false);
    assert.equal(recipe.outputs[0].timeline.length, 1);
  });
});

describe("validateAiVideoSegments", () => {
  it("errors when more than one ai_hook per output", () => {
    const recipe = {
      batchContext: { aiVideoMaxDurationSec: 5 },
      outputs: [{
        outputId: "short",
        timeline: [
          { segmentId: "a", segmentRole: "ai_hook", videoInSec: 0, videoOutSec: 4 },
          { segmentId: "b", segmentRole: "ai_hook", videoInSec: 0, videoOutSec: 4 },
        ],
      }],
    };
    const issues = validateAiVideoSegments(recipe);
    assert.ok(issues.some((issue) => issue.code === "V26-AIVIDEO-01"));
  });
});
