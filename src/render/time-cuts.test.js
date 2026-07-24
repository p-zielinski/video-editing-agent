import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAudioTimeCutsToRange,
  applyVideoTimeCutsToRange,
  buildTimeCutKeepRanges,
} from "./time-cuts.js";

describe("time-cuts", () => {
  it("buildTimeCutKeepRanges returns segment-relative spans", () => {
    const ranges = buildTimeCutKeepRanges(
      [{ atOutputSec: 2, gapSec: 0.04 }],
      0,
      5,
    );
    assert.deepEqual(ranges, [
      { start: 0, end: 2 },
      { start: 2.04, end: 5 },
    ]);
  });

  it("applyVideoTimeCutsToRange splits before trim when multiple keep ranges", () => {
    const filter = applyVideoTimeCutsToRange({
      videoLabel: "[vcutin]",
      timeCuts: [{ atOutputSec: 2, gapSec: 0.04 }],
      rangeStartSec: 0,
      rangeEndSec: 5,
    });
    assert.match(filter, /\[vcutin\]split=2\[vts0\]\[vts1\]/);
    assert.match(filter, /\[vts0\]trim=start=0:end=2/);
    assert.match(filter, /\[vts1\]trim=start=2\.04:end=5/);
    assert.match(filter, /concat=n=2:v=1:a=0\[vout\]/);
    assert.equal((filter.match(/\[vcutin\]trim/g) ?? []).length, 0);
  });

  it("applyVideoTimeCutsToRange uses single trim without split for one keep range", () => {
    const filter = applyVideoTimeCutsToRange({
      videoLabel: "[vcutin]",
      timeCuts: [{ atOutputSec: 9.96, gapSec: 0.04 }],
      rangeStartSec: 0,
      rangeEndSec: 10,
    });
    assert.match(filter, /\[vcutin\]trim=start=0:end=9\.96,setpts=PTS-STARTPTS\[vout\]/);
    assert.doesNotMatch(filter, /split=/);
    assert.doesNotMatch(filter, /concat/);
  });

  it("applyAudioTimeCutsToRange asplits intermediate label before multi-range atrim", () => {
    const filter = applyAudioTimeCutsToRange({
      audioFilter: "[aduck]",
      timeCuts: [{ atOutputSec: 2, gapSec: 0.04 }],
      rangeStartSec: 0,
      rangeEndSec: 5,
      singleInput: false,
    });
    assert.match(filter, /\[aduck\]asplit=2\[ats0\]\[ats1\]/);
    assert.equal((filter.match(/\[aduck\]atrim/g) ?? []).length, 0);
    assert.match(filter, /\[ats0\]atrim=0:2/);
    assert.match(filter, /\[ats1\]atrim=2\.04:5/);
    assert.match(filter, /concat=n=2:v=0:a=1\[aout\]/);
  });
});
