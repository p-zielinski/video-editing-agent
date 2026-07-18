import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowRepeatedSceneReuse,
  sanitizeInvalidWordCuts,
  sanitizeRecipeHardErrors,
  sanitizeUnmatchedBroll,
} from "../../src/editorial/recipe-hard-error-sanitize.js";

describe("recipe-hard-error-sanitize", () => {
  it("drops cuts whose wordIds are from another clip", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentId: "seg1",
          videoRef: { clipId: "clip27", sceneId: "clip27_scene001" },
          audioRef: { clipId: "clip27", sceneId: "clip27_scene001" },
          cuts: [
            { startWordId: "clip02_w00000", endWordId: "clip02_w00001" },
            { startWordId: "clip27_w00010", endWordId: "clip27_w00012" },
          ],
        }],
      }],
    };

    sanitizeInvalidWordCuts(recipe);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].cuts[0].startWordId, "clip27_w00010");
  });

  it("marks duplicate scene uses with allowBrollReuse", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [
          {
            segmentId: "a",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
          },
          {
            segmentId: "b",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
          },
        ],
      }],
    };

    allowRepeatedSceneReuse(recipe);
    assert.equal(recipe.outputs[0].timeline[0].allowBrollReuse, undefined);
    assert.equal(recipe.outputs[0].timeline[1].allowBrollReuse, true);
  });

  it("sanitizeRecipeHardErrors applies both cleanups", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [
          {
            segmentId: "a",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
            audioRef: { clipId: "clip28" },
            cuts: [{ startWordId: "clip03_w00001", endWordId: "clip03_w00002" }],
          },
          {
            segmentId: "b",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
            audioRef: { clipId: "clip28" },
            cuts: [],
          },
        ],
      }],
    };

    sanitizeRecipeHardErrors(recipe);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
    assert.equal(recipe.outputs[0].timeline[1].allowBrollReuse, true);
  });

  it("reclassifies unmatched broll as aroll under match_speech_topics", () => {
    const recipe = {
      batchContext: { brollStrategy: "match_speech_topics", brollMatchThreshold: 0.55 },
      clipRegistry: [{ clipId: "clip28", clipRole: "speech" }],
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentId: "b1",
          segmentRole: "broll",
          videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
        }],
      }],
    };
    const topicIndex = {
      topics: [{
        matchingScenes: [{ sceneId: "clip01_scene001", score: 0.9 }],
      }],
    };

    sanitizeUnmatchedBroll(recipe, topicIndex);
    assert.equal(recipe.outputs[0].timeline[0].segmentRole, "aroll");
  });
});
