import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTimeCutKeepRanges,
  enrichJumpCutsAsTimeCuts,
  DEFAULT_JUMP_CUT_GAP_SEC,
} from "./time-cuts.js";
import { planBoundaryConcat } from "./boundary-compositor.js";

describe("time-cuts", () => {
  it("buildTimeCutKeepRanges removes gap at cut point", () => {
    const ranges = buildTimeCutKeepRanges(
      [{ atOutputSec: 5, gapSec: 0.04 }],
      0,
      10,
    );
    assert.ok(ranges);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].end, 5);
    assert.equal(ranges[1].start, 5.04);
  });

  it("enrichJumpCutsAsTimeCuts materializes jump_cut into segment timeCuts", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [{
          segmentId: "seg1",
          outputStartSec: 0,
          outputEndSec: 30,
          timeCuts: [],
        }],
      }],
      creativeMoments: [{
        momentId: "jc1",
        techniqueId: "jump_cut",
        outputId: "main_16x9",
        outputStartSec: 12.5,
        outputEndSec: 12.65,
      }],
    };

    enrichJumpCutsAsTimeCuts(recipe);
    const cuts = recipe.outputs[0].timeline[0].timeCuts;
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].atOutputSec, 12.5);
    assert.equal(cuts[0].gapSec, DEFAULT_JUMP_CUT_GAP_SEC);
    assert.equal(recipe.creativeMoments.length, 0);
    assert.equal(recipe.jumpCutMaterialization.count, 1);
  });
});

describe("boundary-compositor plan", () => {
  it("planBoundaryConcat picks two_xfade for 2 segments with crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    const plan = planBoundaryConcat({
      segmentPaths: ["a.mp4", "b.mp4"],
      segments,
      creativeMoments: moments,
      audioIndex: null,
    });
    assert.equal(plan.strategy, "two_xfade");
  });

  it("planBoundaryConcat picks jl_audio when J/L overlap without eligible video xfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30, audioPolicy: "from_video_ref" },
      { outputStartSec: 28, outputEndSec: 60, audioPolicy: "from_prev", overlapSec: 2 },
    ];
    const plan = planBoundaryConcat({
      segmentPaths: ["a.mp4", "b.mp4"],
      segments,
      creativeMoments: [],
      audioIndex: null,
    });
    assert.equal(plan.strategy, "jl_audio");
  });

  it("planBoundaryConcat picks multi_xfade for partial crossfade on 4 segments", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 40 },
    ];
    const moments = [
      { techniqueId: "crossfade", outputStartSec: 10, outputEndSec: 10.3 },
      { techniqueId: "crossfade", outputStartSec: 20, outputEndSec: 20.3 },
    ];
    const plan = planBoundaryConcat({
      segmentPaths: ["a.mp4", "b.mp4", "c.mp4", "d.mp4"],
      segments,
      creativeMoments: moments,
      audioIndex: null,
    });
    assert.equal(plan.strategy, "multi_xfade");
  });

  it("planBoundaryConcat picks hard_concat for 3 segments without crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 19.1 },
      { outputStartSec: 19.1, outputEndSec: 37.274 },
      { outputStartSec: 37.274, outputEndSec: 58 },
    ];
    const plan = planBoundaryConcat({
      segmentPaths: ["a.mp4", "b.mp4", "c.mp4"],
      segments,
      creativeMoments: [],
      audioIndex: null,
    });
    assert.equal(plan.strategy, "hard_concat");
  });
});
