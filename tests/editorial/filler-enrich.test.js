import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichRecipeFillerCuts } from "../../src/editorial/filler-enrich.js";
import { validateFillerCutCoverage } from "../../src/validators/filler-coverage.js";

const abstraction = {
  L1: [
    { sceneId: "clip01_scene001", summary: "Intro z fillerami" },
    { sceneId: "clip01_scene002", summary: "Czysta scena" },
  ],
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], narrativeRole: "setup" },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], narrativeRole: "breath" },
  ],
};

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 10, endSec: 20 },
  ],
  words: [
    { wordId: "clip01_w001", word: "yyy", start: 0.5, end: 0.8, isFiller: true },
    { wordId: "clip01_w002", word: "yyy", start: 1.0, end: 1.3, isFiller: true },
    { wordId: "clip01_w003", word: "yyy", start: 1.5, end: 1.8, isFiller: true },
    { wordId: "clip01_w004", word: "hej", start: 2.0, end: 2.3, isFiller: false },
    { wordId: "clip01_w005", word: "cześć", start: 10.5, end: 10.9, isFiller: false },
  ],
};

const wordIndexes = [{ clipId: "clip01", words: timelineIndex.words }];

function baseRecipe(cuts = []) {
  return {
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      timeline: [{
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 20,
        audioInSec: 0,
        audioOutSec: 20,
        audioPolicy: "from_video_ref",
        cuts,
      }],
    }],
  };
}

describe("enrichRecipeFillerCuts", () => {
  it("adds filler cuts for high-filler L1 scene", () => {
    const recipe = baseRecipe();
    const applied = enrichRecipeFillerCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
    });

    assert.equal(applied, 1);
    assert.deepEqual(recipe.outputs[0].timeline[0].cuts, [{
      startWordId: "clip01_w001",
      endWordId: "clip01_w003",
      reason: "filler",
    }]);
  });

  it("is idempotent when filler cut already exists", () => {
    const recipe = baseRecipe([{
      startWordId: "clip01_w001",
      endWordId: "clip01_w003",
      reason: "filler",
    }]);

    const applied = enrichRecipeFillerCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
    });

    assert.equal(applied, 0);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
  });

  it("skips slow/breath L2 with allowFillerCuts disabled", () => {
    const recipe = {
      ...baseRecipe(),
      narrativeProfile: {
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "slow",
          retentionIntensity: "low",
          enrichPolicy: { allowFillerCuts: false },
        }],
      },
    };

    const applied = enrichRecipeFillerCuts(recipe, {
      abstraction,
      timelineIndex,
      wordIndexes,
    });

    assert.equal(applied, 0);
  });

  it("clears V26-FILLER-01 after enrichment", () => {
    const recipe = baseRecipe();
    enrichRecipeFillerCuts(recipe, { abstraction, timelineIndex, wordIndexes });

    const issues = validateFillerCutCoverage(recipe, { abstraction, timelineIndex });
    assert.equal(issues.length, 0);
  });
});
