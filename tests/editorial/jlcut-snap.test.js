import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeJlCutSnap,
  snapJlCutOverlapSec,
  snapToFrameSec,
} from "../../src/editorial/jlcut-snap.js";

const wordIndexes = [{
  clipId: "clip01",
  words: [
    { wordId: "clip01_w001", word: "hello", start: 0, end: 1.2 },
    { wordId: "clip01_w002", word: "world", start: 1.3, end: 2.5 },
    { wordId: "clip01_w003", word: "again", start: 8.5, end: 9.7 },
  ],
}];

describe("jlcut-snap", () => {
  it("snaps overlap to nearest word boundary for J-cut", () => {
    const prevSeg = {
      segmentId: "s1",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
    };
    const seg = {
      segmentId: "s2",
      audioPolicy: "from_prev",
      overlapSec: 1.7,
      videoInSec: 0,
      videoOutSec: 8,
    };

    const snapped = snapJlCutOverlapSec(prevSeg, seg, wordIndexes, { fps: 30 });
    assert.equal(snapped, 0.3);
  });

  it("quantizes overlap to frame boundary", () => {
    assert.equal(snapToFrameSec(1.016, 30), 1.0);
    assert.ok(Math.abs(snapToFrameSec(1.05, 30) - 1.067) < 0.001);
  });

  it("enrichRecipeJlCutSnap updates timeline overlapSec", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        format: "16:9",
        timeline: [
          {
            segmentId: "s1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
            overlapSec: 0,
          },
          {
            segmentId: "s2",
            segmentRole: "broll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
            videoInSec: 0,
            videoOutSec: 8,
            audioInSec: 0,
            audioOutSec: 8,
            audioPolicy: "from_prev",
            overlapSec: 1.7,
          },
        ],
      }],
    };

    enrichRecipeJlCutSnap(recipe, wordIndexes);
    const seg2 = recipe.outputs[0].timeline[1];
    assert.equal(seg2.overlapSec, 0.3);
    assert.ok(seg2.jlCutSnapMeta);
  });
});
