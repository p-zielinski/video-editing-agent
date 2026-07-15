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

  const baseShortOutput = () => ({
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
  });

  it("prepends ai_hook segment when director accepted matching clipId", () => {
    const recipe = {
      outputs: [{
        ...baseShortOutput(),
        aiHookDecision: {
          action: "accept",
          clipId: "ai_hook_01",
          reason: "Strong opening transition",
        },
      }],
    };

    const changed = enrichRecipeAiHook(recipe, aiArtifact);
    assert.equal(changed, true);
    assert.equal(recipe.outputs[0].timeline[0].segmentRole, "ai_hook");
    assert.equal(recipe.outputs[0].timeline[0].segmentId, AI_HOOK_SEGMENT_ID);
    assert.equal(recipe.outputs[0].timeline[0].audioPolicy, "from_next");
  });

  it("skips when artifact not succeeded", () => {
    const recipe = { outputs: [{ ...baseShortOutput(), timeline: [] }] };
    assert.equal(enrichRecipeAiHook(recipe, { status: "failed" }), false);
  });

  it("skips when director rejected hook", () => {
    const recipe = {
      outputs: [{
        ...baseShortOutput(),
        aiHookDecision: {
          action: "reject",
          clipId: "ai_hook_01",
          reason: "Mismatched tone",
        },
      }],
    };
    assert.equal(enrichRecipeAiHook(recipe, aiArtifact), false);
    assert.equal(recipe.outputs[0].timeline.length, 1);
  });

  it("skips when aiHookDecision is missing", () => {
    const recipe = { outputs: [baseShortOutput()] };
    assert.equal(enrichRecipeAiHook(recipe, aiArtifact), false);
  });

  it("skips when accepted clipId does not match artifact", () => {
    const recipe = {
      outputs: [{
        ...baseShortOutput(),
        aiHookDecision: {
          action: "accept",
          clipId: "ai_hook_02",
          reason: "wrong id",
        },
      }],
    };
    assert.equal(enrichRecipeAiHook(recipe, aiArtifact), false);
  });

  it("preserves existing ai_hook segment without changes", () => {
    const recipe = {
      outputs: [{
        outputId: "vertical_main",
        format: "9:16",
        timeline: [{
          segmentId: "director_hook",
          segmentRole: "ai_hook",
          videoRef: {
            clipId: "ai_hook_01",
            sceneId: "ai_hook_01_scene001",
          },
        }, {
          segmentId: "seg_main",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
        }],
        aiHookDecision: {
          action: "accept",
          clipId: "ai_hook_01",
          reason: "already placed",
        },
      }],
    };

    assert.equal(enrichRecipeAiHook(recipe, aiArtifact), false);
    assert.equal(recipe.outputs[0].timeline.length, 2);
    assert.equal(recipe.outputs[0].timeline[0].segmentRole, "ai_hook");
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
