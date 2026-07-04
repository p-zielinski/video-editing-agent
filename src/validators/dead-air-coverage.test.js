import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateDeadAirCoverage,
  DEAD_AIR_COVERAGE_VALIDATOR_CODE,
} from "./dead-air-coverage.js";

const wordIndexes = [{
  clipId: "clip01",
  words: [
    { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
    { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
  ],
}];

const perClipAnalysis = [{
  clipId: "clip01",
  silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
}];

function buildRecipe({ cuts = [], creativeMoments = [] } = {}) {
  return {
    batchContext: { requiredFormats: ["16:9"] },
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "seg1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 30,
        audioInSec: 0,
        audioOutSec: 30,
        audioPolicy: "from_video_ref",
        cuts,
      }],
    }],
    creativeMoments,
  };
}

describe("validateDeadAirCoverage", () => {
  const audioIndex = { clips: [{ clipId: "clip01" }] };

  it("warns V26-DEADAIR-01 when source-both dead air has no cut or silence_beat", () => {
    const issues = validateDeadAirCoverage(buildRecipe(), {
      audioIndex,
      perClipAnalysis,
      wordIndexes,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, DEAD_AIR_COVERAGE_VALIDATOR_CODE);
    assert.equal(issues[0].severity, "warning");
    assert.match(issues[0].message, /source: both/);
  });

  it("passes when dead_air cut brackets the hint gap", () => {
    const issues = validateDeadAirCoverage(buildRecipe({
      cuts: [{
        startWordId: "clip01_w001",
        endWordId: "clip01_w002",
        reason: "dead_air",
      }],
    }), {
      audioIndex,
      perClipAnalysis,
      wordIndexes,
    });

    assert.equal(issues.length, 0);
  });

  it("passes when silence_beat moment covers hint end within tolerance", () => {
    const issues = validateDeadAirCoverage(buildRecipe({
      creativeMoments: [{
        momentId: "enrich_silence_001",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 6,
        outputEndSec: 6.8,
        params: { durationSec: 0.8 },
      }],
    }), {
      audioIndex,
      perClipAnalysis,
      wordIndexes,
    });

    assert.equal(issues.length, 0);
  });
});
