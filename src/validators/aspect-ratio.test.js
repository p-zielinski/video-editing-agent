import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAspectRatio, buildSceneAspectMap } from "./aspect-ratio.js";

describe("aspect-ratio validator", () => {
  const sceneAspectById = buildSceneAspectMap([
    { sceneId: "clip01_scene001", aspectRatio: "9:16" },
    { sceneId: "clip02_scene001", aspectRatio: "16:9" },
  ]);

  it("warns V25-AR-02 for vertical A-roll in main 16:9", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.ok(issues.some((issue) => issue.code === "V25-AR-02"));
  });

  it("does not warn for vertical broll in main 16:9 without transform", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg_broll",
          segmentRole: "broll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_audio_ref",
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.equal(issues.length, 0);
  });

  it("does not warn when fitMode is pillarbox_blur", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "broll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_audio_ref",
          videoTransform: { fitMode: "pillarbox_blur" },
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.equal(issues.length, 0);
  });

  it("does not warn when fitMode is set", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "broll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_audio_ref",
          videoTransform: { fitMode: "pillarbox" },
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.equal(issues.length, 0);
  });

  it("does not warn when videoTransform.reframe is set", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
          videoTransform: { reframe: "center" },
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.equal(issues.length, 0);
  });

  it("does not warn when aspects match", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
        }],
      }],
    };

    const issues = validateAspectRatio(recipe, { sceneAspectById });
    assert.equal(issues.length, 0);
  });
});
