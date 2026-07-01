import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpatialRefFromAnchor,
  findBestAnchor,
  findAnchorNearTimestamp,
  buildSpatialRefExamples,
  deriveClipIdFromSceneId,
} from "../../src/editorial/spatial-ref.js";

const spatialIndex = {
  version: "1.0",
  batchId: "test01",
  scenes: [
    {
      sceneId: "clip01_scene001",
      clipId: "clip01",
      anchors: [
        {
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.82,
        },
        {
          type: "face",
          bbox: [0.2, 0.25, 0.35, 0.45],
          timestampSec: 5.5,
          label: "face",
          confidence: 0.7,
        },
      ],
    },
    {
      sceneId: "clip02_scene001",
      clipId: "clip02",
      anchors: [],
    },
  ],
};

describe("spatial-ref", () => {
  it("deriveClipIdFromSceneId extracts clip prefix", () => {
    assert.equal(deriveClipIdFromSceneId("clip01_scene001"), "clip01");
    assert.equal(deriveClipIdFromSceneId("myclip_scene012"), "myclip");
  });

  it("buildSpatialRefFromAnchor produces valid spatialRef", () => {
    const anchor = spatialIndex.scenes[0].anchors[0];
    const ref = buildSpatialRefFromAnchor("clip01_scene001", "clip01", anchor);
    assert.deepEqual(ref, {
      clipId: "clip01",
      sceneId: "clip01_scene001",
      anchorType: "subject",
      bbox: [0.1, 0.2, 0.5, 0.6],
      timestampSec: 5,
    });
  });

  it("findBestAnchor returns primary by default", () => {
    const anchor = findBestAnchor(spatialIndex, "clip01_scene001");
    assert.equal(anchor.type, "subject");
  });

  it("findBestAnchor prefers requested type", () => {
    const anchor = findBestAnchor(spatialIndex, "clip01_scene001", "face");
    assert.equal(anchor.type, "face");
  });

  it("findBestAnchor returns null when scene has no anchors", () => {
    assert.equal(findBestAnchor(spatialIndex, "clip02_scene001"), null);
  });

  it("findAnchorNearTimestamp picks anchor closest to source time", () => {
    const anchor = findAnchorNearTimestamp(spatialIndex, "clip01_scene001", 5.4, "face");
    assert.equal(anchor.type, "face");
    assert.equal(anchor.timestampSec, 5.5);
  });

  it("buildSpatialRefExamples returns up to limit examples", () => {
    const examples = buildSpatialRefExamples(spatialIndex, 2);
    assert.equal(examples.length, 1);
    assert.equal(examples[0].sceneId, "clip01_scene001");
    assert.equal(examples[0].anchorType, "subject");
  });
});
