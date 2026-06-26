import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRenderEdl } from "./build-render-edl.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  loadFixtureArtifact,
  resolveFixtureBatch,
} from "../test-helpers/fixture-work-dir.js";

describe("buildRenderEdl", () => {
  const workDir = resolveFixtureBatch("mini-day");
  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
  const context = resolveRenderContext(workDir, recipe);

  it("builds EDL for horizontal_main with resolved source paths and output times", () => {
    const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
    const edl = buildRenderEdl(output, recipe, context);

    assert.equal(edl.outputId, "horizontal_main");
    assert.equal(edl.format, "16:9");
    assert.equal(edl.segments.length, 3);
    assert.equal(edl.durationSec, 57);

    const [seg1, seg2, seg3] = edl.segments;
    assert.equal(seg1.segmentId, "seg_h1");
    assert.equal(seg1.videoSourcePath, "/inbox/01_talk.MOV");
    assert.equal(seg1.audioSourcePath, "/inbox/01_talk.MOV");
    assert.equal(seg1.audioPolicy, "from_video_ref");
    assert.equal(seg1.outputStartSec, 0);
    assert.equal(seg1.outputEndSec, 30);

    assert.equal(seg2.segmentId, "seg_h2");
    assert.equal(seg2.videoSourcePath, "/inbox/02_broll.MOV");
    assert.equal(seg2.audioSourcePath, "/inbox/01_talk.MOV");
    assert.equal(seg2.audioPolicy, "from_audio_ref");
    assert.equal(seg2.outputStartSec, 30);
    assert.equal(seg2.outputEndSec, 37);

    assert.equal(seg3.segmentId, "seg_h3");
    assert.equal(seg3.outputStartSec, 37);
    assert.equal(seg3.outputEndSec, 57);
    assert.deepEqual(seg1.cuts, []);
  });

  it("builds EDL for short_9x16 output", () => {
    const output = recipe.outputs.find((entry) => entry.outputId === "short_9x16");
    const edl = buildRenderEdl(output, recipe, context);

    assert.equal(edl.outputId, "short_9x16");
    assert.equal(edl.format, "9:16");
    assert.equal(edl.segments.length, 1);
    assert.equal(edl.segments[0].videoInSec, 2);
    assert.equal(edl.segments[0].videoOutSec, 60);
    assert.equal(edl.durationSec, 58);
  });

  it("resolves external audioPolicy to music bed file path", () => {
    const recipeWithMusic = structuredClone(recipe);
    recipeWithMusic.audioMixPlan = {
      musicBed: { trackId: "upbeat_vlog_01", volumeDb: -18 },
    };
    const musicContext = resolveRenderContext(workDir, recipeWithMusic);
    const output = {
      outputId: "music_test",
      format: "16:9",
      timeline: [{
        segmentId: "music_seg",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 0.1,
        audioInSec: 0,
        audioOutSec: 30,
        audioPolicy: "external",
      }],
    };

    const edl = buildRenderEdl(output, recipeWithMusic, musicContext);
    assert.equal(edl.segments[0].audioPolicy, "external");
    if (musicContext.musicBed.trackFilePath) {
      assert.equal(edl.segments[0].audioSourcePath, musicContext.musicBed.trackFilePath);
    } else {
      assert.equal(edl.segments[0].audioSourcePath, null);
    }
  });
});
