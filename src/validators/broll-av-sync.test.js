import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBrollAvSync } from "./broll-av-sync.js";

describe("broll-av-sync validator", () => {
  it("warns V25-BROLL-01 when B-roll video and audio durations diverge", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [{
          segmentId: "b1",
          segmentRole: "broll",
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 3,
          audioInSec: 0,
          audioOutSec: 8,
          audioPolicy: "from_audio_ref",
        }],
      }],
    };

    const issues = validateBrollAvSync(recipe);
    assert.ok(issues.some((issue) => issue.code === "V25-BROLL-01"));
  });

  it("passes when durations are within tolerance", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [{
          segmentId: "b1",
          segmentRole: "broll",
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5.2,
          audioPolicy: "from_audio_ref",
        }],
      }],
    };

    const issues = validateBrollAvSync(recipe);
    assert.equal(issues.length, 0);
  });
});
