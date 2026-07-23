import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findCrossfadeAtBoundary,
  collectCrossfadesAtBoundaries,
  buildTwoSegmentXfadeFilterComplex,
  buildMultiSegmentXfadeFilterComplex,
  buildHardConcatFilterComplex,
  computeXfadeOffsetAtBoundary,
  isTwoSegmentCrossfadeEligible,
  isMultiSegmentCrossfadeEligible,
  isCrossfadeEligible,
  isJoinCrossfadeEligible,
  resolveJlVideoCrossfadeBoundaries,
  shouldDeferCrossfadeToCreative,
  getCrossfadeNotAppliedReason,
  resolvePostConcatCreativeMoments,
  findCutOnBeatAtBoundary,
  computeBeatSnapAtBoundary,
  sourceSecToOutputSec,
  outputSecToSourceSec,
} from "./ffmpeg-concat.js";

describe("ffmpeg-concat", () => {
  it("finds crossfade moment at segment join boundary", () => {
    const segments = [
      { segmentId: "seg1", outputStartSec: 0, outputEndSec: 30 },
      { segmentId: "seg2", outputStartSec: 30, outputEndSec: 60 },
    ];
    const moments = [{
      techniqueId: "crossfade",
      outputStartSec: 30,
      outputEndSec: 30.5,
      params: { durationSec: 0.4 },
    }];

    const found = findCrossfadeAtBoundary(moments, segments);
    assert.ok(found);
    assert.equal(found.boundaryIndex, 1);
    assert.equal(found.joinSec, 30);
    assert.equal(found.durationSec, 0.4);
  });

  it("ignores crossfade moment not aligned with a join", () => {
    const segments = [
      { segmentId: "seg1", outputStartSec: 0, outputEndSec: 30 },
      { segmentId: "seg2", outputStartSec: 30, outputEndSec: 60 },
    ];
    const moments = [{
      techniqueId: "crossfade",
      outputStartSec: 15,
      outputEndSec: 15.5,
    }];

    assert.equal(findCrossfadeAtBoundary(moments, segments), null);
  });

  it("builds xfade filter_complex for two segments", () => {
    const built = buildTwoSegmentXfadeFilterComplex({ durationSec: 0.3, offsetSec: 29.7 });
    assert.ok(built.filterComplex.includes("xfade=transition=fade:duration=0.3:offset=29.7"));
    assert.ok(built.filterComplex.includes("acrossfade=d=0.3"));
    assert.equal(built.videoMap, "[outv]");
    assert.equal(built.audioMap, "[outa]");
  });

  it("isTwoSegmentCrossfadeEligible true for 2 segments with aligned crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    assert.equal(
      isTwoSegmentCrossfadeEligible(["a.mp4", "b.mp4"], segments, moments),
      true,
    );
  });

  it("isTwoSegmentCrossfadeEligible false for 3+ segments even when crossfade aligns", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
      { outputStartSec: 60, outputEndSec: 90 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    assert.equal(
      isTwoSegmentCrossfadeEligible(["a.mp4", "b.mp4", "c.mp4"], segments, moments),
      false,
    );
  });

  it("isMultiSegmentCrossfadeEligible true for 3 segments with one boundary crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
      { outputStartSec: 60, outputEndSec: 90 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    assert.equal(
      isMultiSegmentCrossfadeEligible(["a.mp4", "b.mp4", "c.mp4"], segments, moments),
      true,
    );
    assert.equal(
      isCrossfadeEligible(["a.mp4", "b.mp4", "c.mp4"], segments, moments),
      true,
    );
  });

  it("isMultiSegmentCrossfadeEligible true when every internal join has crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
    ];
    const moments = [
      { techniqueId: "crossfade", outputStartSec: 10, outputEndSec: 10.3 },
      { techniqueId: "crossfade", outputStartSec: 20, outputEndSec: 20.3 },
    ];
    assert.equal(
      isMultiSegmentCrossfadeEligible(["a.mp4", "b.mp4", "c.mp4"], segments, moments),
      true,
    );
  });

  it("isMultiSegmentCrossfadeEligible true for partial crossfade on 4 segments", () => {
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
    assert.equal(
      isMultiSegmentCrossfadeEligible(["a.mp4", "b.mp4", "c.mp4", "d.mp4"], segments, moments),
      true,
    );
  });

  it("isTwoSegmentCrossfadeEligible false when J/L overlap is present", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30, audioPolicy: "from_video_ref" },
      { outputStartSec: 29.5, outputEndSec: 60, audioPolicy: "from_prev", overlapSec: 0.5 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 29.5, outputEndSec: 30 }];
    assert.equal(
      isTwoSegmentCrossfadeEligible(["a.mp4", "b.mp4"], segments, moments),
      false,
    );
  });

  it("isJoinCrossfadeEligible true for aroll→aroll same clip", () => {
    const outgoing = {
      segmentRole: "aroll",
      outputStartSec: 0,
      outputEndSec: 10,
      videoRef: { clipId: "clip01" },
    };
    const incoming = {
      segmentRole: "aroll",
      outputStartSec: 10,
      outputEndSec: 20,
      videoRef: { clipId: "clip01" },
    };
    assert.equal(isJoinCrossfadeEligible(outgoing, incoming), true);
  });

  it("isJoinCrossfadeEligible true for broll→aroll when both segments exceed 0.5s", () => {
    const outgoing = {
      segmentRole: "broll",
      outputStartSec: 0,
      outputEndSec: 12.5,
      videoRef: { clipId: "clip02" },
    };
    const incoming = {
      segmentRole: "aroll",
      outputStartSec: 12,
      outputEndSec: 25,
      videoRef: { clipId: "clip01" },
    };
    assert.equal(isJoinCrossfadeEligible(outgoing, incoming), true);
  });

  it("isJoinCrossfadeEligible false for broll→aroll when segment duration is 0.5s or less", () => {
    const outgoing = {
      segmentRole: "broll",
      outputStartSec: 0,
      outputEndSec: 0.5,
      videoRef: { clipId: "clip02" },
    };
    const incoming = {
      segmentRole: "aroll",
      outputStartSec: 0.5,
      outputEndSec: 10,
      videoRef: { clipId: "clip01" },
    };
    assert.equal(isJoinCrossfadeEligible(outgoing, incoming), false);
  });

  it("isJoinCrossfadeEligible false for aroll→aroll on different clips", () => {
    const outgoing = {
      segmentRole: "aroll",
      outputStartSec: 0,
      outputEndSec: 10,
      videoRef: { clipId: "clip01" },
    };
    const incoming = {
      segmentRole: "aroll",
      outputStartSec: 10,
      outputEndSec: 20,
      videoRef: { clipId: "clip02" },
    };
    assert.equal(isJoinCrossfadeEligible(outgoing, incoming), false);
  });

  it("resolveJlVideoCrossfadeBoundaries keeps crossfade only on eligible J/L joins", () => {
    const segments = [
      {
        segmentRole: "broll",
        outputStartSec: 0,
        outputEndSec: 12.5,
        videoRef: { clipId: "clip02" },
        audioPolicy: "from_audio_ref",
      },
      {
        segmentRole: "aroll",
        outputStartSec: 12,
        outputEndSec: 32,
        videoRef: { clipId: "clip01" },
        audioPolicy: "from_prev",
        overlapSec: 0.5,
      },
    ];
    const moments = [{
      techniqueId: "crossfade",
      outputStartSec: 12,
      params: { durationSec: 0.4 },
    }];
    const boundaries = resolveJlVideoCrossfadeBoundaries(moments, segments);
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0]?.durationSec, 0.4);
  });

  it("getCrossfadeNotAppliedReason explains ineligible J/L join for crossfade", () => {
    const segments = [
      {
        segmentRole: "aroll",
        outputStartSec: 0,
        outputEndSec: 10,
        videoRef: { clipId: "clip01" },
        audioPolicy: "from_video_ref",
      },
      {
        segmentRole: "aroll",
        outputStartSec: 9.5,
        outputEndSec: 20,
        videoRef: { clipId: "clip02" },
        audioPolicy: "from_prev",
        overlapSec: 0.5,
      },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 9.5, outputEndSec: 10 }];
    const reason = getCrossfadeNotAppliedReason(["a.mp4", "b.mp4"], segments, moments);
    assert.ok(reason?.includes("J/L overlap"));
    assert.ok(reason?.includes("broll→aroll"));
  });

  it("getCrossfadeNotAppliedReason null when J/L join is eligible for video crossfade", () => {
    const segments = [
      {
        segmentRole: "broll",
        outputStartSec: 0,
        outputEndSec: 12.5,
        videoRef: { clipId: "clip02" },
      },
      {
        segmentRole: "aroll",
        outputStartSec: 12,
        outputEndSec: 32,
        videoRef: { clipId: "clip01" },
        audioPolicy: "from_prev",
        overlapSec: 0.5,
      },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 12, outputEndSec: 12.4 }];
    assert.equal(
      getCrossfadeNotAppliedReason(["a.mp4", "b.mp4"], segments, moments),
      null,
    );
  });

  it("shouldDeferCrossfadeToCreative false when 3 segments and crossfade will apply", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
      { outputStartSec: 60, outputEndSec: 90 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    assert.equal(shouldDeferCrossfadeToCreative(moments, segments, false), true);
    assert.equal(shouldDeferCrossfadeToCreative(moments, segments, true), false);
  });

  it("builds chained xfade filter_complex for 3 segments with one crossfade boundary", () => {
    const segmentDurations = [30, 30, 30];
    const crossfadeAtBoundaries = [
      { durationSec: 0.3 },
      null,
    ];
    const built = buildMultiSegmentXfadeFilterComplex({ segmentDurations, crossfadeAtBoundaries });

    assert.ok(built.filterComplex.includes("[s0v][s1v]xfade=transition=fade:duration=0.3:offset=29.7"));
    assert.ok(built.filterComplex.includes("[s0a][s1a]acrossfade=d=0.3"));
    assert.ok(built.filterComplex.includes("[m0v][s2v]concat=n=2:v=1:a=0[m1v]"));
    assert.ok(built.filterComplex.includes("[m0a][s2a]concat=n=2:v=0:a=1[m1a]"));
    assert.equal(built.videoMap, "[m1v]");
    assert.equal(built.audioMap, "[m1a]");
  });

  it("builds chained xfade filter_complex for 3 segments with crossfade at every join", () => {
    const segmentDurations = [10, 10, 10];
    const crossfadeAtBoundaries = [
      { durationSec: 0.5 },
      { durationSec: 0.5 },
    ];
    const built = buildMultiSegmentXfadeFilterComplex({ segmentDurations, crossfadeAtBoundaries });

    assert.ok(built.filterComplex.includes("[s0v][s1v]xfade=transition=fade:duration=0.5:offset=9.5"));
    assert.ok(built.filterComplex.includes("[m0v][s2v]xfade=transition=fade:duration=0.5:offset=19"));
    assert.equal(built.videoMap, "[m1v]");
  });

  it("computeXfadeOffsetAtBoundary accounts for prior crossfades", () => {
    const segmentDurations = [10, 10, 10];
    const crossfadeAtBoundaries = [
      { durationSec: 0.5 },
      { durationSec: 0.5 },
    ];

    assert.equal(
      computeXfadeOffsetAtBoundary(segmentDurations, crossfadeAtBoundaries, 1),
      9.5,
    );
    assert.equal(
      computeXfadeOffsetAtBoundary(segmentDurations, crossfadeAtBoundaries, 2),
      19,
    );
  });

  it("collectCrossfadesAtBoundaries returns per-boundary configs", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
    ];
    const moments = [
      { techniqueId: "crossfade", outputStartSec: 10, params: { durationSec: 0.4 } },
    ];
    const boundaries = collectCrossfadesAtBoundaries(moments, segments);
    assert.equal(boundaries.length, 2);
    assert.ok(boundaries[0]);
    assert.equal(boundaries[0].durationSec, 0.4);
    assert.equal(boundaries[1], null);
  });

  it("getCrossfadeNotAppliedReason null for eligible 3-segment crossfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
      { outputStartSec: 60, outputEndSec: 90 },
    ];
    const moments = [{ techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 }];
    assert.equal(
      getCrossfadeNotAppliedReason(["a.mp4", "b.mp4", "c.mp4"], segments, moments),
      null,
    );
  });

  it("builds chained xfade filter_complex for partial crossfade on 4 segments", () => {
    const segmentDurations = [10, 10, 10, 10];
    const crossfadeAtBoundaries = [
      { durationSec: 0.3 },
      { durationSec: 0.3 },
      null,
    ];
    const built = buildMultiSegmentXfadeFilterComplex({ segmentDurations, crossfadeAtBoundaries });

    assert.ok(built.filterComplex.includes("[s0v][s1v]xfade=transition=fade:duration=0.3:offset=9.7"));
    assert.ok(built.filterComplex.includes("[m0v][s2v]xfade=transition=fade:duration=0.3:offset=19.4"));
    assert.ok(built.filterComplex.includes("[m1v][s3v]concat=n=2:v=1:a=0[m2v]"));
    assert.ok(built.filterComplex.includes("[m1a][s3a]concat=n=2:v=0:a=1[m2a]"));
    assert.equal(built.videoMap, "[m2v]");
    assert.equal(built.audioMap, "[m2a]");
  });

  it("buildHardConcatFilterComplex resets PTS and chains concat for mixed FPS", () => {
    const built = buildHardConcatFilterComplex(3);

    assert.ok(built.filterComplex.includes("[0:v]setpts=PTS-STARTPTS[s0v]"));
    assert.ok(built.filterComplex.includes("[1:a]asetpts=PTS-STARTPTS[s1a]"));
    assert.ok(built.filterComplex.includes("[s0v][s1v]concat=n=2:v=1:a=0[hc1v]"));
    assert.ok(built.filterComplex.includes("[hc1v][s2v]concat=n=2:v=1:a=0[hc2v]"));
    assert.ok(built.filterComplex.includes("[s0a][s1a]concat=n=2:v=0:a=1[hc1a]"));
    assert.equal(built.videoMap, "[hc2v]");
    assert.equal(built.audioMap, "[hc2a]");
  });

  it("getCrossfadeNotAppliedReason null for partial crossfade on 4 segments", () => {
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
    assert.equal(
      getCrossfadeNotAppliedReason(["a.mp4", "b.mp4", "c.mp4", "d.mp4"], segments, moments),
      null,
    );
  });

  it("resolvePostConcatCreativeMoments emits CROSSFADE_NOT_APPLIED for ineligible J/L crossfade join", () => {
    const segments = [
      {
        segmentRole: "aroll",
        outputStartSec: 0,
        outputEndSec: 10,
        videoRef: { clipId: "clip01" },
        audioPolicy: "from_video_ref",
      },
      {
        segmentRole: "aroll",
        outputStartSec: 9.5,
        outputEndSec: 20,
        videoRef: { clipId: "clip02" },
        audioPolicy: "from_prev",
        overlapSec: 0.5,
      },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 9.5, outputEndSec: 10 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: false,
    });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "CROSSFADE_NOT_APPLIED");
    assert.ok(warnings[0].message.includes("J/L overlap"));
    assert.equal(moments.length, 0);
  });

  it("resolvePostConcatCreativeMoments drops crossfade when J/L video xfade was applied", () => {
    const segments = [
      {
        segmentRole: "broll",
        outputStartSec: 0,
        outputEndSec: 12.5,
        videoRef: { clipId: "clip02" },
      },
      {
        segmentRole: "aroll",
        outputStartSec: 12,
        outputEndSec: 32,
        videoRef: { clipId: "clip01" },
        audioPolicy: "from_prev",
        overlapSec: 0.5,
      },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 12, outputEndSec: 12.4 },
      { techniqueId: "zoom_in", outputStartSec: 2, outputEndSec: 5 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: true,
    });

    assert.equal(warnings.length, 0);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "zoom_in");
  });

  it("resolvePostConcatCreativeMoments drops crossfade when partial multi-segment xfade applied", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 10 },
      { outputStartSec: 10, outputEndSec: 20 },
      { outputStartSec: 20, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 40 },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 10, outputEndSec: 10.3 },
      { techniqueId: "crossfade", outputStartSec: 20, outputEndSec: 20.3 },
      { techniqueId: "zoom_in", outputStartSec: 5, outputEndSec: 8 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4", "c.mp4", "d.mp4"],
      appliedCrossfade: true,
    });

    assert.equal(warnings.length, 0);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "zoom_in");
  });

  it("resolvePostConcatCreativeMoments drops crossfade when multi-segment concat applied xfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
      { outputStartSec: 60, outputEndSec: 90 },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 },
      { techniqueId: "zoom_in", outputStartSec: 10, outputEndSec: 15 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4", "c.mp4"],
      appliedCrossfade: true,
    });

    assert.equal(warnings.length, 0);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "zoom_in");
  });

  it("finds cut_on_beat moment at segment join boundary", () => {
    const segments = [
      { segmentId: "seg1", outputStartSec: 0, outputEndSec: 30, videoRef: { clipId: "clip01" } },
      { segmentId: "seg2", outputStartSec: 30, outputEndSec: 60, videoRef: { clipId: "clip02" } },
    ];
    const moments = [{
      techniqueId: "cut_on_beat",
      outputStartSec: 30.05,
      outputEndSec: 30.1,
      params: { snapToleranceSec: 0.5 },
    }];

    const found = findCutOnBeatAtBoundary(moments, segments);
    assert.ok(found);
    assert.equal(found.boundaryIndex, 1);
    assert.equal(found.joinSec, 30);
  });

  it("ignores cut_on_beat moment not aligned with a join", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const moments = [{ techniqueId: "cut_on_beat", outputStartSec: 15, outputEndSec: 15.1 }];

    assert.equal(findCutOnBeatAtBoundary(moments, segments), null);
  });

  it("maps output timeline to source time and back", () => {
    const segment = {
      outputStartSec: 10,
      audioInSec: 5,
      videoInSec: 5,
    };
    assert.equal(outputSecToSourceSec(segment, 20), 15);
    assert.equal(sourceSecToOutputSec(segment, 15), 20);
  });

  it("computeBeatSnapAtBoundary snaps join to nearest beat within tolerance", () => {
    const segments = [
      {
        segmentId: "seg1",
        outputStartSec: 0,
        outputEndSec: 30.2,
        audioInSec: 0,
        videoRef: { clipId: "clip01" },
      },
      {
        segmentId: "seg2",
        outputStartSec: 30.2,
        outputEndSec: 60,
        videoRef: { clipId: "clip02" },
      },
    ];
    const moment = {
      techniqueId: "cut_on_beat",
      outputStartSec: 30.2,
      params: { snapToleranceSec: 0.5 },
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", beatTimes: [0.5, 1.0, 29.8, 30.0] }],
    };

    const snap = computeBeatSnapAtBoundary({
      moment,
      segments,
      boundaryIndex: 1,
      audioIndex,
    });

    assert.ok(snap);
    assert.equal(snap.status, "snapped");
    assert.equal(snap.originalJoinSec, 30.2);
    assert.equal(snap.snappedJoinSec, 30);
    assert.ok(Math.abs(snap.deltaSec - (-0.2)) < 0.001);
    assert.equal(snap.beatSourceSec, 30);
    assert.equal(snap.clipId, "clip01");
  });

  it("computeBeatSnapAtBoundary returns null when beat is outside snap tolerance", () => {
    const segments = [
      {
        outputStartSec: 0,
        outputEndSec: 30,
        audioInSec: 0,
        videoRef: { clipId: "clip01" },
      },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const moment = {
      techniqueId: "cut_on_beat",
      outputStartSec: 30,
      params: { snapToleranceSec: 0.1 },
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", beatTimes: [0.5, 28.0] }],
    };

    assert.equal(
      computeBeatSnapAtBoundary({ moment, segments, boundaryIndex: 1, audioIndex }),
      null,
    );
  });

  it("computeBeatSnapAtBoundary returns already_aligned when join is on beat", () => {
    const segments = [
      {
        outputStartSec: 0,
        outputEndSec: 30,
        audioInSec: 0,
        videoRef: { clipId: "clip01" },
      },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const moment = {
      techniqueId: "cut_on_beat",
      outputStartSec: 30,
      params: { snapToleranceSec: 0.5 },
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", beatTimes: [0.5, 29.5, 30.0] }],
    };

    const snap = computeBeatSnapAtBoundary({
      moment,
      segments,
      boundaryIndex: 1,
      audioIndex,
    });

    assert.ok(snap);
    assert.equal(snap.status, "already_aligned");
    assert.equal(snap.deltaSec, 0);
    assert.equal(snap.snappedJoinSec, 30);
  });

  it("resolvePostConcatCreativeMoments emits CUT_ON_BEAT_ALREADY_ALIGNED when on beat", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const creativeMoments = [
      { techniqueId: "cut_on_beat", outputStartSec: 30, outputEndSec: 30.1 },
    ];
    const alreadyAlignedBeatSnaps = [{
      boundaryIndex: 1,
      originalJoinSec: 30,
      snappedJoinSec: 30,
      deltaSec: 0,
      beatSourceSec: 30,
      clipId: "clip01",
      status: "already_aligned",
    }];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: false,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps,
    });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "CUT_ON_BEAT_ALREADY_ALIGNED");
    assert.equal(moments.length, 0);
  });

  it("resolvePostConcatCreativeMoments does not emit CUT_ON_BEAT_NOT_APPLIED when already aligned", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const creativeMoments = [
      { techniqueId: "cut_on_beat", outputStartSec: 30, outputEndSec: 30.1 },
    ];

    const { warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: false,
      appliedBeatSnaps: [],
      alreadyAlignedBeatSnaps: [{
        boundaryIndex: 1,
        originalJoinSec: 30,
        beatSourceSec: 30,
        clipId: "clip01",
      }],
    });

    assert.equal(warnings.some((w) => w.code === "CUT_ON_BEAT_NOT_APPLIED"), false);
  });

  it("resolvePostConcatCreativeMoments emits CUT_ON_BEAT_SNAPPED when snap applied", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const creativeMoments = [
      { techniqueId: "cut_on_beat", outputStartSec: 30, outputEndSec: 30.1 },
      { techniqueId: "zoom_in", outputStartSec: 10, outputEndSec: 15 },
    ];
    const beatSnaps = [{
      boundaryIndex: 1,
      originalJoinSec: 30.2,
      snappedJoinSec: 30,
      deltaSec: -0.2,
      beatSourceSec: 30,
      clipId: "clip01",
    }];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: false,
      appliedBeatSnaps: beatSnaps,
    });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, "CUT_ON_BEAT_SNAPPED");
    assert.equal(warnings[0].techniqueId, "cut_on_beat");
    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "zoom_in");
  });

  it("resolvePostConcatCreativeMoments drops crossfade when concat applied xfade", () => {
    const segments = [
      { outputStartSec: 0, outputEndSec: 30 },
      { outputStartSec: 30, outputEndSec: 60 },
    ];
    const creativeMoments = [
      { techniqueId: "crossfade", outputStartSec: 30, outputEndSec: 30.5 },
      { techniqueId: "zoom_in", outputStartSec: 10, outputEndSec: 15 },
    ];

    const { moments, warnings } = resolvePostConcatCreativeMoments({
      creativeMoments,
      segments,
      segmentPaths: ["a.mp4", "b.mp4"],
      appliedCrossfade: true,
    });

    assert.equal(warnings.length, 0);
    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "zoom_in");
  });
});
