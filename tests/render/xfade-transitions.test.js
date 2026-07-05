import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildXfadeVideoFilter,
  isBoundaryTransitionTechnique,
  resolveXfadeTransitionType,
} from "../../src/render/xfade-transitions.js";
import { collectCrossfadesAtBoundaries, buildTwoSegmentXfadeFilterComplex, buildMultiSegmentXfadeFilterComplex } from "../../src/render/ffmpeg-concat.js";

describe("xfade-transitions", () => {
  it("maps wipe/slide technique ids to ffmpeg transition names", () => {
    assert.equal(resolveXfadeTransitionType("wipe_left"), "wipeleft");
    assert.equal(resolveXfadeTransitionType("slide_right"), "slideright");
    assert.equal(isBoundaryTransitionTechnique("slide_left"), true);
    assert.equal(isBoundaryTransitionTechnique("jump_cut"), false);
  });

  it("buildXfadeVideoFilter emits wipeleft transition", () => {
    const filter = buildXfadeVideoFilter("v0", "v1", "outv", {
      durationSec: 0.5,
      offsetSec: 9.5,
      transitionType: "wipeleft",
    });
    assert.ok(filter.includes("xfade=transition=wipeleft:duration=0.5:offset=9.5"));
  });

  it("collectCrossfadesAtBoundaries picks slide_left at join", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
    ];
    const creativeMoments = [{
      techniqueId: "slide_left",
      outputStartSec: 10,
      params: { durationSec: 0.4 },
    }];
    const boundaries = collectCrossfadesAtBoundaries(creativeMoments, segments);
    assert.equal(boundaries[0]?.techniqueId, "slide_left");
    assert.equal(boundaries[0]?.transitionType, "slideleft");
  });

  it("buildTwoSegmentXfadeFilterComplex supports custom transition type", () => {
    const built = buildTwoSegmentXfadeFilterComplex({
      durationSec: 0.4,
      offsetSec: 9.6,
      transitionType: "slideright",
    });
    assert.ok(built.filterComplex.includes("xfade=transition=slideright"));
  });

  it("buildMultiSegmentXfadeFilterComplex mixes xfade and hard concat on 4 segments", () => {
    const built = buildMultiSegmentXfadeFilterComplex({
      segmentDurations: [10, 10, 10, 10],
      crossfadeAtBoundaries: [
        { durationSec: 0.4, transitionType: "wipeleft" },
        null,
        { durationSec: 0.3, transitionType: "fade" },
      ],
    });

    assert.ok(built.filterComplex.includes("xfade=transition=wipeleft:duration=0.4:offset=9.6"));
    assert.ok(built.filterComplex.includes("[m0v][s2v]concat=n=2:v=1:a=0[m1v]"));
    assert.ok(built.filterComplex.includes("[m1v][s3v]xfade=transition=fade:duration=0.3"));
    assert.equal(built.videoMap, "[m2v]");
  });
});
