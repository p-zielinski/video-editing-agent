import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSpatialIndex, buildSceneAnchors, normalizeBbox, mergeDetections } from "./spatial-index.js";

const timelineIndex = {
  batchId: "test01",
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 30, hasSpeech: true },
    { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 20, hasSpeech: false },
  ],
  objectDetections: [
    {
      sceneId: "clip01_scene001",
      label: "person",
      confidence: 0.82,
      timestampSec: 5,
      bbox: [0.1, 0.2, 0.5, 0.9],
    },
    {
      sceneId: "clip01_scene001",
      label: "laptop",
      confidence: 0.95,
      timestampSec: 6,
      bbox: [0.4, 0.5, 0.8, 0.7],
    },
    {
      sceneId: "clip01_scene001",
      label: "face",
      confidence: 0.7,
      timestampSec: 5.5,
      bbox: [0.2, 0.25, 0.35, 0.45],
    },
    {
      sceneId: "clip02_scene001",
      label: "food",
      confidence: 0.88,
      timestampSec: 3,
      bbox: [0.3, 0.4, 0.7, 0.8],
    },
  ],
};

describe("spatial_index", () => {
  it("maps person label to subject and prefers face anchor over person", () => {
    const anchors = buildSceneAnchors("clip01_scene001", timelineIndex.objectDetections);
    assert.equal(anchors.length, 2);
    assert.equal(anchors[0].type, "face");
    assert.equal(anchors[0].label, "face");
    assert.deepEqual(anchors[0].bbox, [0.2, 0.25, 0.35, 0.45]);
    assert.equal(anchors[1].type, "subject");
    assert.equal(anchors[1].label, "person");
  });

  it("maps non-person labels to object type", () => {
    const anchors = buildSceneAnchors("clip02_scene001", timelineIndex.objectDetections);
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].type, "object");
    assert.equal(anchors[0].label, "food");
  });

  it("builds spatial index for all scenes", () => {
    const index = buildSpatialIndex(timelineIndex);
    assert.equal(index.version, "1.0");
    assert.equal(index.batchId, "test01");
    assert.equal(index.scenes.length, 2);
    assert.equal(index.scenes[0].clipId, "clip01");
    assert.ok(index.scenes[0].anchors.length > 0);
    assert.equal(index.scenes[1].anchors[0].type, "object");
  });

  it("includes builtFrom metadata when provided", () => {
    const index = buildSpatialIndex(timelineIndex, {
      builtFrom: { timelineIndexMtime: 12345, objectDetectionCount: 4 },
    });
    assert.deepEqual(index.builtFrom, { timelineIndexMtime: 12345, objectDetectionCount: 4 });
  });

  it("returns empty anchors when detections lack bbox", () => {
    const anchors = buildSceneAnchors("clip01_scene001", [
      { sceneId: "clip01_scene001", label: "person", confidence: 0.9, timestampSec: 1 },
    ]);
    assert.deepEqual(anchors, []);
  });

  it("normalizes pixel xywh bbox using scene resolution", () => {
    const scene = {
      sceneId: "clip01_scene001",
      clipId: "clip01",
      resolution: { w: 1920, h: 1080 },
    };
    const anchors = buildSceneAnchors(
      "clip01_scene001",
      [
        {
          sceneId: "clip01_scene001",
          label: "person",
          confidence: 0.82,
          timestampSec: 5,
          bbox: [192, 216, 960, 540],
        },
      ],
      { scene, timelineIndex },
    );

    assert.equal(anchors.length, 1);
    assert.deepEqual(anchors[0].bbox, [0.1, 0.2, 0.5, 0.5]);
  });

  it("normalizes x1y1x2y2 pixel bbox to x,y,w,h", () => {
    const normalized = normalizeBbox([100, 200, 500, 900], { width: 1000, height: 1000 });
    assert.deepEqual(normalized, [0.1, 0.2, 0.4, 0.7]);
  });

  it("prefers x1y1x2y2 when xywh would exceed frame bounds", () => {
    const normalized = normalizeBbox([192, 216, 960, 972], { width: 1920, height: 1080 });
    assert.deepEqual(normalized, [0.1, 0.2, 0.4, 0.7]);
  });

  it("prefers dedicated face detections over florence person labels", () => {
    const faceDetections = [
      {
        type: "face",
        sceneId: "clip01_scene001",
        label: "face",
        confidence: 0.92,
        timestampSec: 5,
        bbox: [0.35, 0.05, 0.3, 0.25],
      },
    ];
    const merged = mergeDetections(timelineIndex.objectDetections, faceDetections);
    const anchors = buildSceneAnchors("clip01_scene001", merged);
    assert.equal(anchors[0].type, "face");
    assert.deepEqual(anchors[0].bbox, [0.35, 0.05, 0.3, 0.25]);
    assert.equal(anchors[1].type, "subject");
  });

  it("buildSpatialIndex includes faceDetectionCount in builtFrom", () => {
    const faceDetections = [
      {
        type: "face",
        sceneId: "clip01_scene001",
        label: "face",
        confidence: 0.6,
        timestampSec: 1,
        bbox: [0.35, 0.05, 0.3, 0.25],
      },
    ];
    const index = buildSpatialIndex(timelineIndex, {
      builtFrom: { timelineIndexMtime: 1, objectDetectionCount: 4, faceDetectionCount: 1 },
      faceDetections,
    });
    assert.equal(index.builtFrom.faceDetectionCount, 1);
    assert.equal(index.scenes[0].anchors[0].type, "face");
  });
});
