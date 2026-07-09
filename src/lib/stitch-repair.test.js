import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairStitchContinuity } from "./stitch-repair.js";
import {
  validateStitchContinuity,
  STITCH_DUPLICATE_SEGMENT_ID,
  STITCH_SEGMENT_MISSING,
} from "../validators/stitch-continuity.js";

const abstraction = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], summary: "Intro" },
    { segmentId: "seg_bridge", sceneIds: ["clip01_scene_bridge"], summary: "Bridge" },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], summary: "Outro" },
  ],
};

const superPlan = {
  segmentOrder: ["seg001", "seg002"],
  segmentPicks: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"] },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"] },
  ],
};

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", durationSec: 30 },
    { sceneId: "clip01_scene_bridge", clipId: "clip01", durationSec: 5 },
    { sceneId: "clip01_scene002", clipId: "clip01", durationSec: 30 },
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

describe("repairStitchContinuity", () => {
  it("dedupes duplicate segmentIds", () => {
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

    const { repaired, unfixable } = repairStitchContinuity(recipe, {
      superPlan,
      abstraction,
      timelineIndex,
    });

    assert.equal(repaired, true);
    assert.equal(unfixable, false);

    const ids = recipe.outputs[0].timeline.map((entry) => entry.segmentId);
    assert.equal(new Set(ids).size, ids.length);

    const issues = validateStitchContinuity(recipe, { superPlan, abstraction });
    assert.ok(!issues.some((issue) => issue.code === STITCH_DUPLICATE_SEGMENT_ID));
  });

  it("inserts bridge segment for missing L2 pick", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [segment("s1", "clip01_scene001")],
      }],
    };

    const { repaired } = repairStitchContinuity(recipe, {
      superPlan,
      abstraction,
      timelineIndex,
    });

    assert.equal(repaired, true);
    assert.ok(recipe.outputs[0].timeline.length >= 2);

    const issues = validateStitchContinuity(recipe, { superPlan, abstraction });
    assert.ok(!issues.some((issue) => issue.code === STITCH_SEGMENT_MISSING));
  });

  it("reports unfixable empty timeline", () => {
    const recipe = {
      outputs: [{ outputId: "main_16x9", outputKind: "main", timeline: [] }],
    };

    const { unfixable, repaired } = repairStitchContinuity(recipe, {
      superPlan,
      abstraction,
    });

    assert.equal(unfixable, true);
    assert.equal(repaired, false);
  });
});
