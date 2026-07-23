import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { subjectFitsInCropWindow, unionAnchorBbox } from "./reframe.js";

describe("reframe helpers", () => {
  it("unions multiple anchor bboxes", () => {
    const union = unionAnchorBbox([
      { bbox: [0.1, 0.2, 0.2, 0.3] },
      { bbox: [0.5, 0.2, 0.2, 0.3] },
    ]);
    assert.deepEqual(union, { x: 0.1, y: 0.2, w: 0.6, h: 0.3 });
  });

  it("detects when subject union is too wide for 9:16 crop", () => {
    const fits = subjectFitsInCropWindow({
      unionBbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      sourceAspect: 16 / 9,
      targetAspect: 9 / 16,
    });
    assert.equal(fits, false);
  });
});
