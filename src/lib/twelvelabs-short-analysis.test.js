import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planShortClipFrameTimestamps } from "./twelvelabs-short-analysis.js";

describe("twelvelabs-short-analysis", () => {
  it("plans a single mid frame for clips under 2s", () => {
    assert.deepEqual(planShortClipFrameTimestamps(1.6), [0.8]);
  });

  it("plans start/mid/end for clips at least 2s", () => {
    const stamps = planShortClipFrameTimestamps(3);
    assert.equal(stamps.length, 3);
    assert.ok(stamps[0] < stamps[1]);
    assert.ok(stamps[1] < stamps[2]);
  });
});
