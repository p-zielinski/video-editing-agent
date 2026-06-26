import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrateRecipeV1ToV2, migrateSegmentV1ToV2 } from "./migrate-recipe-v1-v2.js";

describe("migrate v1 to v2", () => {
  it("migrates segment sourceRef to videoRef/audioRef", () => {
    const v1Seg = {
      segmentId: "s1",
      sourceRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 30,
      audioPolicy: "source",
      audioOffsetSec: 2,
      textOverlays: [{ text: "hi", startSec: 1, endSec: 3, position: "bottom" }],
    };

    const v2 = migrateSegmentV1ToV2(v1Seg);
    assert.equal(v2.segmentRole, "aroll");
    assert.deepEqual(v2.videoRef, { clipId: "clip01", sceneId: "clip01_scene001" });
    assert.deepEqual(v2.audioRef, { clipId: "clip01", sceneId: "clip01_scene001" });
    assert.equal(v2.audioInSec, 2);
    assert.equal(v2.audioOutSec, 32);
    assert.equal(v2.audioPolicy, "from_video_ref");
    assert.equal(v2.sourceRef, undefined);
    assert.equal(v2.textOverlays[0].outputStartSec, 1);
  });

  it("migrates full recipe to v2.0", () => {
    const v1 = {
      version: "1.0",
      batchId: "b1",
      batchContext: { theme: "test", qualityOverQuantity: true },
      outputs: [
        {
          outputId: "h1",
          format: "16:9",
          title: "Main",
          timeline: [
            {
              segmentId: "s1",
              sourceRef: { clipId: "clip01", sceneId: "clip01_scene001" },
              videoInSec: 0,
              videoOutSec: 10,
              audioPolicy: "source",
            },
          ],
        },
        {
          outputId: "v1",
          format: "9:16",
          title: "Vert",
          timeline: [
            {
              segmentId: "s2",
              sourceRef: { clipId: "clip01", sceneId: "clip01_scene002" },
              videoInSec: 0,
              videoOutSec: 8,
              audioPolicy: "source",
            },
          ],
        },
      ],
      excluded: [{ clipId: "clip02", reason: "outtakes" }],
      sceneUsageRegistry: [],
    };

    const v2 = migrateRecipeV1ToV2(v1, {
      clipRegistry: [{ clipId: "clip01", fileName: "a.mov", durationSec: 100, sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true, speechWordCount: 50 }],
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(v2.version, "2.0");
    assert.equal(v2.batchContext.inputMode, "single_clip");
    assert.equal(v2.outputs[0].outputKind, "main");
    assert.equal(v2.outputs[0].timeline[0].audioPolicy, "from_video_ref");
    assert.equal(v2.excluded[0].exclusionType, "whole_clip");
    assert.equal(v2.clipRegistry.length, 1);
  });
});
