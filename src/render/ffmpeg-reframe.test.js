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
    clip_vertical: { resolution: { w: 1080, h: 1920 } },
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
    assert.equal(filter.type, "vf");
    assert.match(filter.filter, /crop=\d+:\d+:\d+:\d+/);
    assert.ok(filter.filter.includes("scale=1080:1920"));
    assert.ok(!filter.filter.includes("pad="));
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
    assert.equal(filter.type, "vf");
    assert.ok(filter.filter.includes("scale=1920:1080"));
    assert.ok(filter.filter.includes("pad=1920:1080"));
    assert.ok(!filter.filter.includes("crop="));
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

    assert.ok(filter?.type === "vf" && filter.filter.includes("setpts=PTS/1.5"));
  });

  it("pillarboxes 1080x1920 source into 16:9 output by default", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.ok(filter);
    assert.equal(filter.type, "vf");
    assert.ok(filter.filter.includes("scale=1920:1080"));
    assert.ok(filter.filter.includes("pad=1920:1080"));
    assert.ok(!filter.filter.includes("crop="));
  });

  it("fills 1080x1920 source into 16:9 when fitMode is fill", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
        videoTransform: { fitMode: "fill" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.ok(filter);
    assert.equal(filter.type, "vf");
    assert.match(filter.filter, /crop=\d+:\d+:\d+:\d+/);
    assert.ok(filter.filter.includes("scale=1920:1080"));
    assert.ok(!filter.filter.includes("pad="));
  });

  it("pillarboxes 1080x1920 source when only reframe center is set on 16:9 output", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
        videoTransform: { reframe: "center" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.ok(filter);
    assert.equal(filter.type, "vf");
    assert.ok(filter.filter.includes("pad=1920:1080"));
    assert.ok(!filter.filter.includes("crop="));
  });

  it("pillarboxes when fitMode is explicitly pillarbox even with center reframe", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
        videoTransform: { reframe: "center", fitMode: "pillarbox" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.equal(filter.type, "vf");
    assert.ok(filter.filter.includes("pad=1920:1080"));
    assert.ok(!filter.filter.includes("crop="));
  });

  it("blur-pillarboxes 1080x1920 source when fitMode is pillarbox_blur", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
        videoTransform: { fitMode: "pillarbox_blur" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.equal(filter.type, "filter_complex");
    assert.ok(filter.filter.includes("split=2"));
    assert.ok(filter.filter.includes("gblur="));
    assert.ok(filter.filter.includes("overlay="));
    assert.ok(filter.filter.includes("scale=1920:1080"));
    assert.ok(!filter.filter.includes("pad="));
    assert.ok(filter.filter.includes("force_original_aspect_ratio=increase"));
    assert.ok(filter.filter.includes("force_original_aspect_ratio=decrease"));
  });

  it("prefers blur pillarbox over face reframe when fitMode is pillarbox_blur", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip01_scene001" },
        videoTransform: { reframe: "face", fitMode: "pillarbox_blur" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      spatialIndex,
      context,
    });

    assert.equal(filter.type, "filter_complex");
    assert.ok(filter.filter.includes("gblur="));
    assert.ok(!/crop=\d+:\d+:\d+:\d+/.test(filter.filter));
  });

  it("keeps black pillarbox when fitMode is pillarbox (not blur)", () => {
    const filter = buildSegmentVideoFilter({
      segment: {
        videoRef: { clipId: "clip_vertical", sceneId: "clip_vertical_scene001" },
        videoTransform: { fitMode: "pillarbox" },
      },
      format: "16:9",
      dimensions: { width: 1920, height: 1080 },
      context,
    });

    assert.equal(filter.type, "vf");
    assert.ok(filter.filter.includes("pad=1920:1080"));
    assert.ok(!filter.filter.includes("split="));
    assert.ok(!filter.filter.includes("gblur="));
  });
});
