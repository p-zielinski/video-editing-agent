import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBrollStrategy } from "./broll-strategy.js";

function baseRecipe(overrides = {}) {
  return {
    batchContext: { brollStrategy: "match_speech_topics", brollMatchThreshold: 0.55 },
    clipRegistry: [
      { clipId: "clip01", sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true },
      { clipId: "clip02", sortIndex: 1, clipRole: "broll_pool", hasSpeech: false },
    ],
    outputs: [{
      outputId: "main",
      outputKind: "main",
      timeline: [],
    }],
    ...overrides,
  };
}

describe("validateBrollStrategy", () => {
  it("errors on non-VO broll when strategy is minimal", () => {
    const recipe = baseRecipe({
      batchContext: { brollStrategy: "minimal" },
      clipRegistry: [
        { clipId: "clip01", sortIndex: 0, clipRole: "aroll_primary", hasSpeech: false },
        { clipId: "clip02", sortIndex: 1, clipRole: "broll_pool", hasSpeech: false },
      ],
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentRole: "broll",
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioPolicy: "from_video_ref",
        }],
      }],
    });

    const issues = validateBrollStrategy(recipe);
    assert.ok(issues.some((issue) => issue.code === "V25-BROLL-02"));
  });

  it("allows VO broll when strategy is minimal", () => {
    const recipe = baseRecipe({
      batchContext: { brollStrategy: "minimal" },
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentRole: "broll",
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioPolicy: "from_audio_ref",
        }],
      }],
    });

    const issues = validateBrollStrategy(recipe);
    assert.equal(issues.length, 0);
  });

  it("errors when match_speech_topics scene is missing from topic index", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentRole: "broll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioPolicy: "from_audio_ref",
        }],
      }],
    });

    const topicIndex = {
      topics: [{
        topicId: "t1",
        matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
      }],
    };

    const issues = validateBrollStrategy(recipe, { topicIndex });
    assert.ok(issues.some((issue) => issue.code === "V25-BROLL-03"));
  });
});
