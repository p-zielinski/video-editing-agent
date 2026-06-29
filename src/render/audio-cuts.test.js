import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAudioCutsToRange,
  applyVideoCutsToRange,
  buildKeepRanges,
  computeCutsRemovedSec,
} from "./audio-cuts.js";

describe("audio-cuts", () => {
  const wordIndex = {
    words: [
      { wordId: "clip01_w0001", word: "hej", start: 0, end: 0.3 },
      { wordId: "clip01_w0002", word: "yyy", start: 0.3, end: 0.6, isFiller: true },
      { wordId: "clip01_w0003", word: "świat", start: 0.6, end: 1.0 },
    ],
  };

  it("returns anull when no cuts", () => {
    const filter = applyAudioCutsToRange({
      cuts: [],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
      singleInput: true,
    });
    assert.match(filter, /\[aout\]/);
  });

  it("builds concat filter when filler cut present", () => {
    const filter = applyAudioCutsToRange({
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
      singleInput: true,
    });
    assert.match(filter, /concat/);
    assert.match(filter, /atrim=0:0\.3/);
    assert.match(filter, /atrim=0\.6:1/);
  });

  it("builds separate-input audio filter chain", () => {
    const filter = applyAudioCutsToRange({
      audioFilter: "[1:a]",
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      rangeStartSec: 8,
      rangeEndSec: 15,
      singleInput: false,
    });
    assert.match(filter, /\[1:a\]atrim/);
    assert.match(filter, /concat/);
  });

  it("computeCutsRemovedSec sums removed word duration", () => {
    const removed = computeCutsRemovedSec(
      [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      0,
      1,
    );
    assert.equal(removed, 0.3);
  });

  it("buildKeepRanges returns segment-relative spans", () => {
    const ranges = buildKeepRanges(
      [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      0,
      1,
    );
    assert.deepEqual(ranges, [
      { start: 0, end: 0.3 },
      { start: 0.6, end: 1 },
    ]);
  });

  it("applyVideoCutsToRange builds trim+concat for video", () => {
    const filter = applyVideoCutsToRange({
      videoLabel: "[vcutin]",
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
    });
    assert.match(filter, /trim=start=0:end=0\.3/);
    assert.match(filter, /trim=start=0\.6:end=1/);
    assert.match(filter, /concat=n=2:v=1:a=0\[vout\]/);
  });

  it("applyVideoCutsToRange passes through when no cuts", () => {
    const filter = applyVideoCutsToRange({
      videoLabel: "[0:v]",
      cuts: [],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
    });
    assert.match(filter, /\[0:v\]setpts=PTS-STARTPTS\[vout\]/);
  });

  it("computeCutsRemovedSec returns 0 when keepIfStoryCritical", () => {
    const removed = computeCutsRemovedSec(
      [{
        startWordId: "clip01_w0002",
        endWordId: "clip01_w0002",
        reason: "filler",
        keepIfStoryCritical: true,
      }],
      wordIndex,
      0,
      1,
    );
    assert.equal(removed, 0);
  });
});
