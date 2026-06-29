import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOutputTimeline, resolveSegmentOutputDuration } from "./build-output-timeline.js";

describe("buildOutputTimeline", () => {
  it("computes sequential output times from segment durations", () => {
    const output = {
      timeline: [
        {
          segmentId: "s1",
          segmentRole: "aroll",
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
        },
        {
          segmentId: "s2",
          segmentRole: "aroll",
          videoInSec: 0,
          videoOutSec: 15,
          audioInSec: 0,
          audioOutSec: 12,
          audioPolicy: "from_video_ref",
        },
      ],
    };

    const enriched = buildOutputTimeline(output);
    assert.equal(enriched[0].outputStartSec, 0);
    assert.equal(enriched[0].outputEndSec, 10);
    assert.equal(enriched[1].outputStartSec, 10);
    assert.equal(enriched[1].outputEndSec, 25);
  });

  it("extends previous segment audio on J-cut with overlapSec", () => {
    const output = {
      timeline: [
        {
          segmentId: "s1",
          segmentRole: "aroll",
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
        },
        {
          segmentId: "s2",
          segmentRole: "aroll",
          videoInSec: 0,
          videoOutSec: 8,
          audioPolicy: "from_prev",
          overlapSec: 2,
        },
      ],
    };

    const enriched = buildOutputTimeline(output);
    assert.equal(enriched[0].outputEndSec, 12);
    assert.equal(enriched[1].outputStartSec, 10);
  });

  it("respects explicit outputStartSec/outputEndSec", () => {
    const output = {
      timeline: [
        {
          segmentId: "s1",
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
          outputStartSec: 5,
          outputEndSec: 20,
        },
      ],
    };

    const enriched = buildOutputTimeline(output);
    assert.equal(enriched[0].outputStartSec, 5);
    assert.equal(enriched[0].outputEndSec, 20);
  });

  it("shortens segment duration when cuts remove words", () => {
    const wordIndexes = {
      clip01: {
        words: [
          { wordId: "clip01_w004", word: "do", start: 4.6, end: 4.8 },
        ],
      },
    };
    const output = {
      timeline: [
        {
          segmentId: "s1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [
            {
              startWordId: "clip01_w004",
              endWordId: "clip01_w004",
              reason: "tighten_pacing",
            },
          ],
        },
      ],
    };

    const enriched = buildOutputTimeline(output, { wordIndexes });
    assert.equal(enriched[0].outputStartSec, 0);
    assert.equal(enriched[0].outputEndSec, 29.8);
  });
});

describe("resolveSegmentOutputDuration", () => {
  it("uses video duration for from_prev policy", () => {
    const dur = resolveSegmentOutputDuration({
      videoInSec: 0,
      videoOutSec: 8,
      audioPolicy: "from_prev",
    });
    assert.equal(dur, 8);
  });

  it("uses audio duration for fit_video_to_audio syncMode", () => {
    const dur = resolveSegmentOutputDuration({
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 15,
      audioPolicy: "from_audio_ref",
      syncMode: "fit_video_to_audio",
    });
    assert.equal(dur, 15);
  });

  it("uses max of video and audio for align_start", () => {
    const dur = resolveSegmentOutputDuration({
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 15,
      audioPolicy: "from_audio_ref",
      syncMode: "align_start",
    });
    assert.equal(dur, 15);
  });

  it("subtracts cuts removed duration when wordIndex provided", () => {
    const wordIndex = {
      words: [{ wordId: "clip01_w004", word: "do", start: 4.6, end: 4.8 }],
    };
    const dur = resolveSegmentOutputDuration({
      videoInSec: 0,
      videoOutSec: 30,
      audioInSec: 0,
      audioOutSec: 30,
      audioPolicy: "from_video_ref",
      cuts: [{ startWordId: "clip01_w004", endWordId: "clip01_w004" }],
    }, { wordIndex });
    assert.equal(dur, 29.8);
  });
});
