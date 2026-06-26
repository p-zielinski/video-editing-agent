import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  loadFixtureArtifact,
  resolveFixtureBatch,
} from "../test-helpers/fixture-work-dir.js";

describe("resolveRenderContext", () => {
  const workDir = resolveFixtureBatch("mini-day");
  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");

  it("loads scene catalog, word indexes, and clip path map", () => {
    const context = resolveRenderContext(workDir, recipe);

    assert.equal(context.batchId, "miniday1");
    assert.equal(context.clips.clip01.sourcePath, "/inbox/01_talk.MOV");
    assert.equal(context.clips.clip01.fileName, "01_talk.MOV");
    assert.deepEqual(context.clips.clip01.resolution, { w: 1920, h: 1080 });
    assert.equal(context.clips.clip02.sourcePath, "/inbox/02_broll.MOV");
    assert.ok(context.wordIndexes.clip01);
    assert.ok(context.wordIndexes.clip02);
    assert.equal(context.wordIndexes.clip01.words.length, 13);
    assert.equal(context.sceneCatalog.clips.length, 2);
  });

  it("returns null musicBed when recipe has no audioMixPlan", () => {
    const context = resolveRenderContext(workDir, recipe);
    assert.equal(context.musicBed, null);
  });

  it("resolves musicBed.trackId via resolveTrackById", () => {
    const recipeWithMusic = structuredClone(recipe);
    recipeWithMusic.audioMixPlan = {
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "upbeat_vlog_01",
        volumeDb: -18,
        duckingDb: -12,
      },
    };

    const context = resolveRenderContext(workDir, recipeWithMusic);
    assert.equal(context.musicBed.trackId, "upbeat_vlog_01");
    assert.equal(context.musicBed.volumeDb, -18);
    assert.equal(context.musicBed.duckingDb, -12);

    if (context.musicBed.track) {
      assert.equal(context.musicBed.track.trackId, "upbeat_vlog_01");
      assert.ok(context.musicBed.trackFilePath.endsWith("upbeat_vlog_01.mp3"));
      assert.equal(context.musicBed.resolveReason, null);
    } else {
      assert.equal(context.musicBed.track, null);
      assert.equal(context.musicBed.resolveReason, "track_file_missing");
    }
  });
});
