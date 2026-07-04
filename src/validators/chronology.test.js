import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateMultiClipChronology } from "./chronology.js";
import { COLD_OPEN_SEGMENT_ID, REWIND_INTRO_SEGMENT_ID } from "../editorial/chapter-hints.js";

function baseMultiClipRecipe(overrides = {}) {
  return {
    batchContext: { inputMode: "multi_clip_day" },
    clipRegistry: [
      { clipId: "clip01", sortIndex: 0, creationTime: "2026-06-29T08:00:00.000Z" },
      { clipId: "clip02", sortIndex: 1, creationTime: "2026-06-29T18:00:00.000Z" },
    ],
    outputs: [{
      outputId: "main",
      outputKind: "main",
      format: "16:9",
      timeline: [],
    }],
    ...overrides,
  };
}

describe("validateMultiClipChronology", () => {
  it("returns no issues for single_clip", () => {
    const issues = validateMultiClipChronology({
      batchContext: { inputMode: "single_clip" },
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      outputs: [{ outputKind: "main", timeline: [] }],
    });
    assert.equal(issues.length, 0);
  });

  it("flags inverted sortIndex on main A-roll pass", () => {
    const recipe = baseMultiClipRecipe({
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [
          {
            segmentId: "s1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
          },
          {
            segmentId: "s2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 10,
            audioInSec: 0,
            audioOutSec: 10,
            audioPolicy: "from_video_ref",
          },
        ],
      }],
    });

    const issues = validateMultiClipChronology(recipe);
    const chr01 = issues.find((issue) => issue.code === "V25-CHR-01");
    assert.ok(chr01);
    assert.equal(chr01.severity, "error");
  });

  it("allows cold open tease before chronological intro", () => {
    const recipe = baseMultiClipRecipe({
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [
          {
            segmentId: COLD_OPEN_SEGMENT_ID,
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            audioRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            videoInSec: 80,
            videoOutSec: 90,
            audioInSec: 80,
            audioOutSec: 90,
            audioPolicy: "from_video_ref",
          },
          {
            segmentId: REWIND_INTRO_SEGMENT_ID,
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 6,
            audioInSec: 0,
            audioOutSec: 6,
            audioPolicy: "from_video_ref",
          },
          {
            segmentId: "s3",
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            videoInSec: 0,
            videoOutSec: 20,
            audioInSec: 0,
            audioOutSec: 20,
            audioPolicy: "from_video_ref",
          },
        ],
      }],
    });

    const issues = validateMultiClipChronology(recipe);
    assert.equal(issues.filter((issue) => issue.code === "V25-CHR-01").length, 0);
    assert.equal(issues.filter((issue) => issue.code === "V25-CHR-03").length, 0);
  });

  it("errors V25-CHR-03 when cold open exists without rewind intro", () => {
    const recipe = baseMultiClipRecipe({
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [
          {
            segmentId: COLD_OPEN_SEGMENT_ID,
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            audioRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            videoInSec: 0,
            videoOutSec: 8,
            audioInSec: 0,
            audioOutSec: 8,
            audioPolicy: "from_video_ref",
          },
          {
            segmentId: "s2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 20,
            audioInSec: 0,
            audioOutSec: 20,
            audioPolicy: "from_video_ref",
          },
        ],
      }],
    });

    const issues = validateMultiClipChronology(recipe);
    const chr03 = issues.find((issue) => issue.code === "V25-CHR-03");
    assert.ok(chr03);
    assert.equal(chr03.severity, "error");
  });

  it("errors V25-CHR-03 when tease scene opens main without rewind intro", () => {
    const recipe = baseMultiClipRecipe({
      outputs: [{
        outputId: "main",
        outputKind: "main",
        timeline: [
          {
            segmentId: "tease_open",
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            audioRef: { clipId: "clip02", sceneId: "clip02_scene002" },
            videoInSec: 80,
            videoOutSec: 90,
            audioInSec: 80,
            audioOutSec: 90,
            audioPolicy: "from_video_ref",
          },
          {
            segmentId: "s2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 20,
            audioInSec: 0,
            audioOutSec: 20,
            audioPolicy: "from_video_ref",
          },
        ],
      }],
    });

    const issues = validateMultiClipChronology(recipe, { teaseSceneId: "clip02_scene002" });
    const chr03 = issues.find((issue) => issue.code === "V25-CHR-03");
    assert.ok(chr03);
    assert.equal(chr03.severity, "error");
  });
});
