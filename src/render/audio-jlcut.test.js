import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  overlapAtBoundary,
  hasJlCutOverlap,
  segmentHasEmbeddedAudio,
  buildJlCutFilterComplex,
} from "./audio-jlcut.js";

describe("audio-jlcut", () => {
  const baseSegments = [
    { segmentId: "s1", audioPolicy: "from_video_ref", overlapSec: 0, outputStartSec: 0, outputEndSec: 10 },
    { segmentId: "s2", audioPolicy: "from_prev", overlapSec: 2, outputStartSec: 10, outputEndSec: 20 },
    { segmentId: "s3", audioPolicy: "from_video_ref", overlapSec: 0, outputStartSec: 20, outputEndSec: 30 },
  ];

  it("detects overlap at J-cut boundary", () => {
    assert.equal(overlapAtBoundary(baseSegments, 1), 2);
    assert.equal(overlapAtBoundary(baseSegments, 2), 0);
  });

  it("detects L-cut overlap from previous segment", () => {
    const segments = [
      { audioPolicy: "from_video_ref", overlapSec: 0 },
      { audioPolicy: "from_next", overlapSec: 1.5 },
      { audioPolicy: "from_video_ref", overlapSec: 0 },
    ];
    assert.equal(overlapAtBoundary(segments, 2), 1.5);
  });

  it("hasJlCutOverlap returns true when overlapSec > 0", () => {
    assert.equal(hasJlCutOverlap(baseSegments), true);
    assert.equal(hasJlCutOverlap([
      { audioPolicy: "from_prev", overlapSec: 0 },
      { audioPolicy: "from_video_ref", overlapSec: 0 },
    ]), true);
  });

  it("segmentHasEmbeddedAudio reflects segment-pass audio embedding", () => {
    assert.equal(segmentHasEmbeddedAudio({ audioPolicy: "from_prev" }), true);
    assert.equal(segmentHasEmbeddedAudio({ audioPolicy: "from_next" }), false);
    assert.equal(segmentHasEmbeddedAudio({ audioPolicy: "mute" }), false);
    assert.equal(segmentHasEmbeddedAudio({ audioPolicy: "from_video_ref" }), true);
    assert.equal(segmentHasEmbeddedAudio({ audioPolicy: "from_audio_ref" }), true);
  });

  it("builds filter_complex with acrossfade at overlap boundary", () => {
    const paths = ["/tmp/seg0.mp4", "/tmp/seg1.mp4", "/tmp/seg2.mp4"];
    const built = buildJlCutFilterComplex(paths, baseSegments);

    assert.ok(built.filterComplex.includes("concat=n=3:v=1:a=0[outv]"));
    assert.ok(built.filterComplex.includes("acrossfade=d=2:c1=tri:c2=tri"));
    assert.ok(built.filterComplex.includes("trim=start=2"));
    assert.ok(built.filterComplex.includes("apad=whole_dur=28"));
    assert.ok(!built.filterComplex.includes("anullsrc"));
    assert.equal(built.videoMap, "[outv]");
    assert.equal(built.audioMap, "[outa]");
  });

  it("extends previous segment video with tpad for J-cut from_next", () => {
    const segments = [
      {
        audioPolicy: "from_next",
        overlapSec: 1.5,
        outputStartSec: 0,
        outputEndSec: 10,
      },
      {
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        outputStartSec: 9.5,
        outputEndSec: 20,
      },
    ];
    const built = buildJlCutFilterComplex(["/a.mp4", "/b.mp4"], segments);

    assert.ok(built.filterComplex.includes("tpad=stop_mode=clone:stop_duration=1.5"));
    assert.ok(built.filterComplex.includes("apad=whole_dur=19"));
  });

  it("carry-forward logic for 3-segment timeline with from_prev on index 2", () => {
    const segments = [
      {
        segmentId: "seg_h1",
        audioPolicy: "from_video_ref",
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
        overlapSec: 0,
        outputStartSec: 0,
        outputEndSec: 10,
      },
      {
        segmentId: "seg_h2",
        audioPolicy: "from_audio_ref",
        videoInSec: 5,
        videoOutSec: 10,
        audioInSec: 8,
        audioOutSec: 20,
        overlapSec: 0,
        outputStartSec: 10,
        outputEndSec: 22,
      },
      {
        segmentId: "seg_h3",
        audioPolicy: "from_prev",
        videoInSec: 90,
        videoOutSec: 110,
        overlapSec: 0.5,
        outputStartSec: 22,
        outputEndSec: 42,
      },
    ];
    const built = buildJlCutFilterComplex(["/a.mp4", "/b.mp4", "/c.mp4"], segments);

    assert.ok(built.filterComplex.includes("[2:a]"), "from_prev segment uses own audio after overlap carry");
    assert.ok(!built.filterComplex.includes("anullsrc"));
    assert.ok(built.filterComplex.includes("[carry2]"));
    assert.ok(built.filterComplex.includes("[own2]"));
    assert.ok(built.filterComplex.includes("[1:a]"));
    assert.ok(built.filterComplex.includes("atrim=start="));
    assert.ok(built.filterComplex.includes("acrossfade=d=0.5"));
    assert.ok(built.filterComplex.includes("duration=0.5"));
    assert.ok(built.filterComplex.includes("duration=19.5"));
    assert.ok(built.filterComplex.includes("apad=whole_dur=41.5"));
    assert.equal(built.audioMap, "[outa]");
  });

  it("carry-forward atrim start accounts for cuts on previous segment", () => {
    const wordIndex = {
      words: [
        { wordId: "clip01_w004", word: "do", start: 4.6, end: 4.8, isFiller: false },
      ],
    };
    const segments = [
      {
        segmentId: "seg_h1",
        audioPolicy: "from_video_ref",
        videoRef: { clipId: "clip01" },
        audioRef: { clipId: "clip01" },
        videoInSec: 0,
        videoOutSec: 30,
        audioInSec: 0,
        audioOutSec: 30,
        overlapSec: 0,
        outputStartSec: 0,
        outputEndSec: 29.8,
        cuts: [{ startWordId: "clip01_w004", endWordId: "clip01_w004", reason: "tighten_pacing" }],
        wordIndex,
      },
      {
        segmentId: "seg_h3",
        audioPolicy: "from_prev",
        videoInSec: 90,
        videoOutSec: 110,
        overlapSec: 0.5,
        outputStartSec: 29.3,
        outputEndSec: 49.3,
      },
    ];
    const built = buildJlCutFilterComplex(["/a.mp4", "/b.mp4"], segments);

    assert.ok(built.filterComplex.includes("atrim=start=29.3"));
    assert.ok(!built.filterComplex.includes("atrim=start=29.5"));
  });

  it("chains audio with concat when no overlap", () => {
    const segments = [
      {
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
      },
      {
        audioPolicy: "from_prev",
        overlapSec: 0,
        videoInSec: 0,
        videoOutSec: 8,
        outputStartSec: 10,
        outputEndSec: 18,
      },
    ];
    const built = buildJlCutFilterComplex(["/a.mp4", "/b.mp4"], segments);
    assert.ok(!built.filterComplex.includes("anullsrc"));
    assert.ok(built.filterComplex.includes("[1:a]"));
    assert.ok(!built.filterComplex.includes("[carry1]"));
    assert.ok(built.filterComplex.includes("[own1]"));
    assert.ok(built.filterComplex.includes("duration=8"));
    assert.ok(built.filterComplex.includes("concat=n=2:v=0:a=1"));
  });

  it("from_prev carry uses overlapSec not full next video duration", () => {
    const segments = [
      {
        audioPolicy: "from_video_ref",
        videoInSec: 0,
        videoOutSec: 4,
        audioInSec: 0,
        audioOutSec: 4,
        overlapSec: 0,
      },
      {
        audioPolicy: "from_prev",
        overlapSec: 0.4,
        videoInSec: 0,
        videoOutSec: 6,
        outputStartSec: 4,
        outputEndSec: 10,
      },
    ];
    const built = buildJlCutFilterComplex(["/a.mp4", "/b.mp4"], segments);

    assert.ok(built.filterComplex.includes("duration=0.4"), "carry from prev is overlapSec only");
    assert.ok(built.filterComplex.includes("duration=5.6"), "remainder uses next segment own audio");
    assert.ok(!built.filterComplex.includes("duration=6"), "must not carry full next video duration");
    assert.ok(built.filterComplex.includes("[carry1]"));
    assert.ok(built.filterComplex.includes("[own1]"));
    assert.ok(built.filterComplex.includes("[1:a]"));
  });

  it("builds filter_complex with video xfade when crossfadeAtBoundaries provided", () => {
    const segments = [
      {
        segmentRole: "broll",
        audioPolicy: "from_audio_ref",
        outputStartSec: 0,
        outputEndSec: 12.5,
        videoInSec: 0,
        videoOutSec: 12.5,
        audioInSec: 0,
        audioOutSec: 12.5,
      },
      {
        segmentRole: "aroll",
        audioPolicy: "from_prev",
        overlapSec: 0.5,
        outputStartSec: 12,
        outputEndSec: 32,
        videoInSec: 0,
        videoOutSec: 20,
      },
    ];
    const built = buildJlCutFilterComplex(
      ["/a.mp4", "/b.mp4"],
      segments,
      [{ durationSec: 0.4 }],
    );

    assert.ok(built.filterComplex.includes("xfade=transition=fade:duration=0.4"));
    assert.ok(built.filterComplex.includes("acrossfade=d=0.5"));
    assert.ok(!built.filterComplex.includes("concat=n=2:v=1:a=0[outv]"));
  });
});
