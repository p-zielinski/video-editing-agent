import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realignEdlAfterBeatSnaps, shiftSecAtOutputTime } from "./realign-edl-beat-snaps.js";

describe("realignEdlAfterBeatSnaps", () => {
  it("shifts segment output times after a negative-delta beat snap", () => {
    const edl = {
      outputId: "main",
      durationSec: 60,
      segments: [
        { segmentId: "seg1", outputStartSec: 0, outputEndSec: 30.2 },
        { segmentId: "seg2", outputStartSec: 30.2, outputEndSec: 60 },
      ],
      creativeMoments: [
        { techniqueId: "zoom_in", outputStartSec: 35, outputEndSec: 40 },
        { techniqueId: "cut_on_beat", outputStartSec: 30.2, outputEndSec: 30.3 },
      ],
    };
    const beatSnaps = [{
      boundaryIndex: 1,
      originalJoinSec: 30.2,
      snappedJoinSec: 30,
      deltaSec: -0.2,
    }];

    realignEdlAfterBeatSnaps(edl, beatSnaps);

    assert.equal(edl.segments[0].outputStartSec, 0);
    assert.equal(edl.segments[0].outputEndSec, 30);
    assert.equal(edl.segments[1].outputStartSec, 30);
    assert.equal(edl.segments[1].outputEndSec, 59.8);
    assert.equal(edl.durationSec, 59.8);
    assert.equal(edl.creativeMoments[0].outputStartSec, 34.8);
    assert.equal(edl.creativeMoments[0].outputEndSec, 39.8);
    assert.equal(edl.creativeMoments[1].outputStartSec, 30);
    assert.equal(edl.creativeMoments[1].outputEndSec, 30.1);
  });

  it("leaves EDL unchanged when beatSnaps is empty or deltas are zero", () => {
    const edl = {
      durationSec: 60,
      segments: [
        { outputStartSec: 0, outputEndSec: 30 },
        { outputStartSec: 30, outputEndSec: 60 },
      ],
      creativeMoments: [{ outputStartSec: 35, outputEndSec: 40 }],
    };
    const before = JSON.stringify(edl);

    realignEdlAfterBeatSnaps(edl, []);
    assert.equal(JSON.stringify(edl), before);

    realignEdlAfterBeatSnaps(edl, [{
      boundaryIndex: 1,
      originalJoinSec: 30,
      snappedJoinSec: 30,
      deltaSec: 0,
    }]);
    assert.equal(JSON.stringify(edl), before);
  });

  it("applies cumulative shifts for multiple boundary snaps", () => {
    const edl = {
      durationSec: 90,
      segments: [
        { outputStartSec: 0, outputEndSec: 30 },
        { outputStartSec: 30, outputEndSec: 60 },
        { outputStartSec: 60, outputEndSec: 90 },
      ],
      creativeMoments: [{ outputStartSec: 65, outputEndSec: 70 }],
    };
    const beatSnaps = [
      {
        boundaryIndex: 1,
        originalJoinSec: 30,
        snappedJoinSec: 29.8,
        deltaSec: -0.2,
      },
      {
        boundaryIndex: 2,
        originalJoinSec: 60,
        snappedJoinSec: 59.7,
        deltaSec: -0.3,
      },
    ];

    realignEdlAfterBeatSnaps(edl, beatSnaps);

    assert.equal(edl.segments[0].outputEndSec, 29.8);
    assert.equal(edl.segments[1].outputStartSec, 29.8);
    assert.equal(edl.segments[1].outputEndSec, 59.5);
    assert.equal(edl.segments[2].outputStartSec, 59.5);
    assert.equal(edl.segments[2].outputEndSec, 89.5);
    assert.equal(edl.durationSec, 89.5);
    assert.equal(edl.creativeMoments[0].outputStartSec, 64.5);
  });

  it("shifts subtitle word timings after negative-delta beat snap at join", () => {
    const edl = {
      durationSec: 60,
      segments: [
        { outputStartSec: 0, outputEndSec: 30.2 },
        {
          outputStartSec: 30.2,
          outputEndSec: 60,
          subtitles: {
            policy: "word_by_word",
            sourceClipId: "clip01",
            words: [
              { word: "hello", outputStartSec: 31, outputEndSec: 31.5 },
            ],
          },
        },
      ],
    };

    realignEdlAfterBeatSnaps(edl, [{
      boundaryIndex: 1,
      originalJoinSec: 30.2,
      snappedJoinSec: 30,
      deltaSec: -0.2,
    }]);

    assert.equal(edl.segments[1].subtitles.words[0].outputStartSec, 30.8);
    assert.equal(edl.segments[1].subtitles.words[0].outputEndSec, 31.3);
  });

  it("shifts subtitle phrase outputStartSec/outputEndSec after snap boundary", () => {
    const edl = {
      durationSec: 60,
      segments: [
        { outputStartSec: 0, outputEndSec: 30.2 },
        {
          outputStartSec: 30.2,
          outputEndSec: 60,
          subtitles: {
            policy: "phrase",
            sourceClipId: "clip01",
            outputStartSec: 32,
            outputEndSec: 35,
          },
        },
      ],
    };

    realignEdlAfterBeatSnaps(edl, [{
      boundaryIndex: 1,
      originalJoinSec: 30.2,
      snappedJoinSec: 30,
      deltaSec: -0.2,
    }]);

    assert.equal(edl.segments[1].subtitles.outputStartSec, 31.8);
    assert.equal(edl.segments[1].subtitles.outputEndSec, 34.8);
  });

  it("shifts textOverlays on segments after snap boundary", () => {
    const edl = {
      durationSec: 60,
      segments: [
        { outputStartSec: 0, outputEndSec: 30.2, textOverlays: [] },
        {
          outputStartSec: 30.2,
          outputEndSec: 60,
          textOverlays: [{ outputStartSec: 32, outputEndSec: 35, text: "hi" }],
        },
      ],
    };

    realignEdlAfterBeatSnaps(edl, [{
      boundaryIndex: 1,
      originalJoinSec: 30.2,
      snappedJoinSec: 30,
      deltaSec: -0.2,
    }]);

    assert.equal(edl.segments[1].textOverlays[0].outputStartSec, 31.8);
    assert.equal(edl.segments[1].textOverlays[0].outputEndSec, 34.8);
  });
});

describe("shiftSecAtOutputTime", () => {
  it("returns cumulative delta for times at or after join", () => {
    const snaps = [
      { originalJoinSec: 30, deltaSec: -0.2 },
      { originalJoinSec: 60, deltaSec: -0.1 },
    ];
    assert.equal(shiftSecAtOutputTime(snaps, 25), 0);
    assert.equal(shiftSecAtOutputTime(snaps, 30), -0.2);
    assert.equal(shiftSecAtOutputTime(snaps, 45), -0.2);
    assert.ok(Math.abs(shiftSecAtOutputTime(snaps, 60) + 0.3) < 0.001);
  });
});
