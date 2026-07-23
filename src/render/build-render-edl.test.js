import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRenderEdl } from "./build-render-edl.js";
import { resolveRenderContext } from "./resolve-render-context.js";
import { ARTIFACTS } from "../pipeline/work-paths.js";
import {
  loadFixtureArtifact,
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

describe("buildRenderEdl", () => {
  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");

  it("builds EDL for horizontal_main with resolved source paths and output times", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-edl" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((entry) => entry.outputId === "horizontal_main");
      const edl = buildRenderEdl(output, recipe, context);

      assert.equal(edl.outputId, "horizontal_main");
      assert.equal(edl.format, "16:9");
      assert.equal(edl.segments.length, 3);
      assert.equal(edl.durationSec, 61.8);

      const [seg1, seg2, seg3] = edl.segments;
      assert.equal(seg1.segmentId, "seg_h1");
      assert.ok(seg1.videoSourcePath.endsWith("01_talk.MOV"));
      assert.ok(seg1.audioSourcePath.endsWith("01_talk.MOV"));
      assert.equal(seg1.audioPolicy, "from_video_ref");
      assert.equal(seg1.outputStartSec, 0);
      assert.equal(seg1.outputEndSec, 29.8);
      assert.equal(seg1.cuts.length, 1);
      assert.equal(seg1.cuts[0].startWordId, "clip01_w004");

      assert.equal(seg2.segmentId, "seg_h2");
      assert.ok(seg2.videoSourcePath.endsWith("02_broll.MOV"));
      assert.ok(seg2.audioSourcePath.endsWith("01_talk.MOV"));
      assert.notEqual(seg2.videoSourcePath, seg2.audioSourcePath);
      assert.equal(seg2.audioPolicy, "from_audio_ref");
      assert.equal(seg2.syncMode, "loop_video");
      assert.equal(seg2.outputStartSec, 29.8);
      assert.equal(seg2.outputEndSec, 42.3);

      assert.equal(seg3.segmentId, "seg_h3");
      assert.equal(seg3.audioPolicy, "from_prev");
      assert.equal(seg3.overlapSec, 0.5);
      assert.equal(seg3.outputStartSec, 41.8);
      assert.equal(seg3.outputEndSec, 61.8);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("builds EDL for short_9x16 output", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-edl-short" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);
      const output = recipe.outputs.find((entry) => entry.outputId === "short_9x16");
      const edl = buildRenderEdl(output, recipe, context);

      assert.equal(edl.outputId, "short_9x16");
      assert.equal(edl.format, "9:16");
      assert.equal(edl.segments.length, 1);
      assert.equal(edl.segments[0].videoInSec, 2);
      assert.equal(edl.segments[0].videoOutSec, 62);
      assert.equal(edl.segments[0].syncMode, "fit_video_to_audio");
      assert.equal(edl.segments[0].subtitles?.policy, "word_by_word");
      assert.equal(edl.durationSec, 58);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("resolves external audioPolicy to music bed file path", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-edl-music" });
    try {
      seedClipSourceFiles(workDir);
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
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("uses original audio when preserveAmbientAudio despite director accept + enhanced path", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-edl-ambient" });
    try {
      seedClipSourceFiles(workDir);
      const enhancedDir = path.join(workDir, "enhanced-audio");
      fs.mkdirSync(enhancedDir, { recursive: true });
      fs.writeFileSync(path.join(enhancedDir, "clip01.wav"), "fake");
      fs.writeFileSync(
        path.join(workDir, ARTIFACTS.audioEnhancementIndex),
        JSON.stringify({
          version: "1.0",
          batchId: "miniday1",
          clips: [{
            version: "1.0",
            candidateId: "enh_clip01",
            clipId: "clip01",
            status: "succeeded",
            provider: "dpdfnet",
            outputPath: "enhanced-audio/clip01.wav",
          }],
        }, null, 2),
      );

      const recipeWithAccept = structuredClone(recipe);
      recipeWithAccept.audioEnhancementDecisions = [{
        candidateId: "enh_clip01",
        clipId: "clip01",
        action: "accept",
        dialogueValue: "useful",
        reason: "ok",
        providerPreference: "auto",
      }];

      const context = resolveRenderContext(workDir, recipeWithAccept);
      const enhancedPath = context.enhancedAudioPaths.clip01;
      assert.ok(enhancedPath, "expected enhanced path in context for accept decision");

      const output = {
        outputId: "ambient_test",
        format: "16:9",
        timeline: [{
          segmentId: "ambient_seg",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
          audioPolicy: "from_video_ref",
          preserveAmbientAudio: true,
        }],
      };

      const edl = buildRenderEdl(output, recipeWithAccept, context);
      const seg = edl.segments[0];
      assert.equal(seg.preserveAmbientAudio, true);
      assert.ok(seg.audioSourcePath.endsWith("01_talk.MOV"));
      assert.notEqual(seg.audioSourcePath, enhancedPath);
    } finally {
      cleanupWorkDir(workDir);
    }
  });
});
