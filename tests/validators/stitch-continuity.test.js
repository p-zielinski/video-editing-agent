import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateStitchContinuity,
  STITCH_EMPTY_TIMELINE,
  STITCH_SEGMENT_MISSING,
  STITCH_DUPLICATE_SEGMENT_ID,
} from "../../src/validators/stitch-continuity.js";

const abstraction = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"] },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"] },
  ],
};

const superPlan = {
  segmentOrder: ["seg001", "seg002"],
  segmentPicks: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"] },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"] },
  ],
};

function segment(id, sceneId) {
  return {
    segmentId: id,
    segmentRole: "aroll",
    videoRef: { clipId: "clip01", sceneId },
    audioRef: { clipId: "clip01", sceneId },
    videoInSec: 0,
    videoOutSec: 10,
    audioInSec: 0,
    audioOutSec: 10,
    audioPolicy: "from_video_ref",
  };
}

describe("validateStitchContinuity", () => {
  it("errors on empty merged timeline", () => {
    const issues = validateStitchContinuity(
      { outputs: [{ outputId: "main_16x9", outputKind: "main", timeline: [] }] },
      { superPlan, abstraction },
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, STITCH_EMPTY_TIMELINE);
    assert.equal(issues[0].severity, "error");
  });

  it("errors when L2 pick is not represented", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [segment("s1", "clip01_scene001")],
      }],
    };

    const issues = validateStitchContinuity(recipe, { superPlan, abstraction });
    assert.ok(issues.some((issue) => issue.code === STITCH_SEGMENT_MISSING));
  });

  it("errors on duplicate segmentIds", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [
          segment("dup", "clip01_scene001"),
          segment("dup", "clip01_scene002"),
        ],
      }],
    };

    const issues = validateStitchContinuity(recipe, { superPlan, abstraction });
    assert.ok(issues.some((issue) => issue.code === STITCH_DUPLICATE_SEGMENT_ID));
  });

  it("passes valid merged recipe with both L2 picks", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [
          segment("s1", "clip01_scene001"),
          segment("s2", "clip01_scene002"),
        ],
      }],
    };

    const partials = [
      { segmentId: "seg001", outputs: [{ outputId: "main_16x9", timeline: [segment("s1", "clip01_scene001")] }] },
      { segmentId: "seg002", outputs: [{ outputId: "main_16x9", timeline: [segment("s2", "clip01_scene002")] }] },
    ];

    const issues = validateStitchContinuity(recipe, { superPlan, abstraction, partials });
    const errors = issues.filter((issue) => issue.severity === "error");
    assert.equal(errors.length, 0);
  });
});
