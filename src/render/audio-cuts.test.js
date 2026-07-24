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
    assert.match(filter, /\[0:a\]asplit=2\[as0\]\[as1\]/);
    assert.match(filter, /\[as0\]atrim=0:0\.3/);
    assert.match(filter, /\[as1\]atrim=0\.6:1/);
  });

  it("builds separate-input audio filter chain", () => {
    const filter = applyAudioCutsToRange({
      audioFilter: "[1:a]",
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
      singleInput: false,
    });
    assert.match(filter, /\[1:a\]asplit=2/);
    assert.match(filter, /\[as0\]atrim=0:0\.3/);
    assert.match(filter, /\[as1\]atrim=0\.6:1/);
    assert.match(filter, /concat/);
  });

  it("asplits intermediate duck label before multi-range atrim", () => {
    const filter = applyAudioCutsToRange({
      audioFilter: "[aduck]",
      cuts: [{ startWordId: "clip01_w0002", endWordId: "clip01_w0002", reason: "filler" }],
      wordIndex,
      rangeStartSec: 0,
      rangeEndSec: 1,
      singleInput: false,
    });
    assert.match(filter, /\[aduck\]asplit=2\[as0\]\[as1\]/);
    assert.equal((filter.match(/\[aduck\]atrim/g) ?? []).length, 0);
    assert.match(filter, /\[as0\]atrim=0:0\.3/);
    assert.match(filter, /\[as1\]atrim=0\.6:1/);
  });

  it("uses single atrim without asplit when one keep range", () => {
    const filter = applyAudioCutsToRange({
      audioFilter: "[aduck]",
      cuts: [{ startWordId: "clip01_w0001", endWordId: "clip01_w0001", reason: "filler" }],
      wordIndex: {
        words: [
          { wordId: "clip01_w0001", word: "yyy", start: 0, end: 0.3, isFiller: true },
          { wordId: "clip01_w0002", word: "hello", start: 0.3, end: 1.0 },
        ],
      },
      rangeStartSec: 0,
      rangeEndSec: 1,
      singleInput: false,
    });
    assert.match(filter, /\[aduck\]atrim=0\.3:1,asetpts=PTS-STARTPTS\[aout\]/);
    assert.doesNotMatch(filter, /asplit=/);
    assert.doesNotMatch(filter, /concat/);
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
    assert.match(filter, /\[vcutin\]split=2\[vs0\]\[vs1\]/);
    assert.match(filter, /\[vs0\]trim=start=0:end=0\.3/);
    assert.match(filter, /\[vs1\]trim=start=0\.6:end=1/);
    assert.match(filter, /concat=n=2:v=1:a=0\[vout\]/);
    assert.equal((filter.match(/\[vcutin\]trim/g) ?? []).length, 0);
  });

  it("applyVideoCutsToRange uses single trim without split when one keep range", () => {
    const filter = applyVideoCutsToRange({
      videoLabel: "[vcutin]",
      cuts: [{ startWordId: "clip01_w0001", endWordId: "clip01_w0001", reason: "filler" }],
      wordIndex: {
        words: [
          { wordId: "clip01_w0001", word: "yyy", start: 0, end: 0.3, isFiller: true },
          { wordId: "clip01_w0002", word: "hello", start: 0.3, end: 1.0 },
        ],
      },
      rangeStartSec: 0,
      rangeEndSec: 1,
    });
    assert.match(filter, /\[vcutin\]trim=start=0\.3:end=1,setpts=PTS-STARTPTS\[vout\]/);
    assert.doesNotMatch(filter, /split=/);
    assert.doesNotMatch(filter, /concat/);
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

  it("buildKeepRanges removes silence gap for dead_air cuts", () => {
    const gapWordIndex = {
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    };
    const ranges = buildKeepRanges(
      [{ startWordId: "clip01_w001", endWordId: "clip01_w002", reason: "dead_air" }],
      gapWordIndex,
      0,
      8,
    );
    assert.deepEqual(ranges, [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
  });

  it("computeCutsRemovedSec sums dead_air gap duration", () => {
    const gapWordIndex = {
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    };
    const removed = computeCutsRemovedSec(
      [{ startWordId: "clip01_w001", endWordId: "clip01_w002", reason: "dead_air" }],
      gapWordIndex,
      0,
      8,
    );
    assert.equal(removed, 4);
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
