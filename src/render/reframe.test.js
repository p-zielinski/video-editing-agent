import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeReframeCrop } from "./reframe.js";
import { loadFixtureArtifact } from "../test-helpers/fixture-work-dir.js";

describe("computeReframeCrop", () => {
  const spatialIndex = loadFixtureArtifact("mini-day", "05c-spatial-index.json");
  const faceAnchor = spatialIndex.scenes[0].anchors.find((a) => a.type === "face");

  const sourceResolution = { w: 1920, h: 1080 };

  it("returns full frame for 16:9 when source is 16:9", () => {
    const crop = computeReframeCrop({
      format: "16:9",
      spatialAnchor: { bbox: faceAnchor.bbox },
      sourceResolution,
    });
    assert.deepEqual(crop, { x: 0, y: 0, w: 1, h: 1 });
  });

  it("computes 9:16 crop centered on face anchor", () => {
    const crop = computeReframeCrop({
      format: "9:16",
      spatialAnchor: { bbox: faceAnchor.bbox, anchorType: "face" },
      sourceResolution,
    });

    const expectedCropW = (9 / 16) / (1920 / 1080);
    assert.ok(Math.abs(crop.w - expectedCropW) < 0.001);
    assert.equal(crop.h, 1);

    const faceCx = faceAnchor.bbox[0] + faceAnchor.bbox[2] / 2;
    const expectedX = Math.min(Math.max(faceCx - crop.w / 2, 0), 1 - crop.w);
    assert.ok(Math.abs(crop.x - expectedX) < 0.001);
    assert.equal(crop.y, 0);
  });

  it("centers 9:16 crop when no spatial anchor", () => {
    const crop = computeReframeCrop({
      format: "9:16",
      sourceResolution,
    });

    const expectedCropW = (9 / 16) / (1920 / 1080);
    assert.ok(Math.abs(crop.w - expectedCropW) < 0.001);
    assert.ok(Math.abs(crop.x - (1 - crop.w) / 2) < 0.001);
    assert.equal(crop.y, 0);
  });

  it("keeps crop box within normalized bounds", () => {
    const crop = computeReframeCrop({
      format: "9:16",
      spatialAnchor: { bbox: [0.95, 0.9, 0.04, 0.08] },
      sourceResolution,
    });

    assert.ok(crop.x >= 0);
    assert.ok(crop.y >= 0);
    assert.ok(crop.x + crop.w <= 1.0001);
    assert.ok(crop.y + crop.h <= 1.0001);
  });
});
