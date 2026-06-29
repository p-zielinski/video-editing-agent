import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSegmentVideoFilter } from "./ffmpeg-reframe.js";

const spatialIndex = {
  scenes: [{
    sceneId: "clip01_scene001",
    clipId: "clip01",
    anchors: [{
      type: "face",
      bbox: [0.4, 0.2, 0.5, 0.4],
    }],
  }],
};

const context = {
  clips: {
    clip01: { resolution: { w: 1920, h: 1080 } },
  },
};

describe("ffmpeg-reframe", () => {
  it("builds 9:16 crop with spatial bbox anchor and scale", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoTransform: { reframe: "face" },
      },
      format: "9:16",
      dimensions: { width: 1080, height: 1920 },
      spatialIndex,
      context,
    });

    assert.ok(filter);
    assert.match(filter, /crop=\d+:\d+:\d+:\d+/);
    assert.ok(filter.includes("scale=1080:1920"));
    assert.ok(!filter.includes("pad="));
  });

  it("pads 16:9 source when no reframe needed", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      spatialIndex,
      context,
    });

    assert.ok(filter);
    assert.ok(filter.includes("scale=1920:1080"));
    assert.ok(filter.includes("pad=1920:1080"));
    assert.ok(!filter.includes("crop="));
  });

  it("applies setpts when speed differs from 1", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoTransform: { speed: 1.5 },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.ok(filter?.includes("setpts=PTS/1.5"));
  });
});
