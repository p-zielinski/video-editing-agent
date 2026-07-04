import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFillerCutCoverage,
  FILLER_COVERAGE_VALIDATOR_CODE,
} from "./filler-coverage.js";

const abstraction = {
  L1: [
    { sceneId: "clip01_scene001", summary: "Intro z fillerami" },
    { sceneId: "clip01_scene002", summary: "Czysta scena" },
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
    { wordId: "clip01_w006", word: "świat", start: 11.0, end: 11.4, isFiller: false },
  ],
};

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

describe("validateFillerCutCoverage", () => {
  it("warns V26-FILLER-01 when high-filler L1 scene has no cuts on its words", () => {
    const issues = validateFillerCutCoverage(baseRecipe(), { abstraction, timelineIndex });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, FILLER_COVERAGE_VALIDATOR_CODE);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].sceneId, "clip01_scene001");
    assert.match(issues[0].message, /75%/);
  });

  it("passes when a cut references words from the high-filler scene", () => {
    const issues = validateFillerCutCoverage(
      baseRecipe([{ startWordId: "clip01_w002", endWordId: "clip01_w003", reason: "filler" }]),
      { abstraction, timelineIndex },
    );

    assert.equal(issues.length, 0);
  });

  it("skips when abstraction or timelineIndex missing", () => {
    assert.equal(validateFillerCutCoverage(baseRecipe(), {}).length, 0);
    assert.equal(validateFillerCutCoverage(baseRecipe(), { abstraction }).length, 0);
  });
});
