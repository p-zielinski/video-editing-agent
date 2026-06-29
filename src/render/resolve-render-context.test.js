import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { resolveRenderContext } from "./resolve-render-context.js";
import {
  loadFixtureArtifact,
  copyFixtureToWorkDir,
  cleanupWorkDir,
} from "../test-helpers/fixture-work-dir.js";
import { seedClipSourceFiles } from "../test-helpers/seed-clip-sources.js";

describe("resolveRenderContext", () => {
  const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");

  it("loads scene catalog, word indexes, and clip path map", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);

      assert.equal(context.batchId, "miniday1");
      assert.ok(context.clips.clip01.sourcePath.endsWith("01_talk.MOV"));
      assert.equal(context.clips.clip01.fileName, "01_talk.MOV");
      assert.deepEqual(context.clips.clip01.resolution, { w: 1920, h: 1080 });
      assert.ok(context.clips.clip02.sourcePath.endsWith("02_broll.MOV"));
      assert.ok(context.wordIndexes.clip01);
      assert.ok(context.wordIndexes.clip02);
      assert.equal(context.wordIndexes.clip01.words.length, 13);
      assert.equal(context.sceneCatalog.clips.length, 2);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("returns null musicBed when recipe has no audioMixPlan", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx-music" });
    try {
      seedClipSourceFiles(workDir);
      const recipeWithoutMusic = structuredClone(recipe);
      delete recipeWithoutMusic.audioMixPlan;
      const context = resolveRenderContext(workDir, recipeWithoutMusic);
      assert.equal(context.musicBed, null);
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("resolves musicBed from golden recipe audioMixPlan", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx-bed" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);
      assert.equal(context.musicBed.trackId, "upbeat_vlog_01");
      assert.equal(context.musicBed.volumeDb, -20);
      assert.equal(context.musicBed.duckingDb, -12);

      if (context.musicBed.track) {
        assert.equal(context.musicBed.track.trackId, "upbeat_vlog_01");
        assert.ok(context.musicBed.trackFilePath.endsWith("upbeat_vlog_01.mp3"));
        assert.equal(context.musicBed.resolveReason, null);
      } else {
        assert.equal(context.musicBed.track, null);
        assert.equal(context.musicBed.resolveReason, "track_file_missing");
      }
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("loads spatialIndex from 05c-spatial-index.json when present", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx-spatial" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);
      assert.ok(context.spatialIndex);
      assert.ok(Array.isArray(context.spatialIndex.scenes));
      assert.ok(context.spatialIndex.scenes.length > 0);
      assert.equal(context.spatialIndex.scenes[0].sceneId, "clip01_scene001");
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("loads audioIndex from 05d-audio-index.json when present", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx-audio" });
    try {
      seedClipSourceFiles(workDir);
      const context = resolveRenderContext(workDir, recipe);
      assert.ok(context.audioIndex);
      assert.ok(Array.isArray(context.audioIndex.clips));
      assert.equal(context.audioIndex.clips[0].clipId, "clip01");
    } finally {
      cleanupWorkDir(workDir);
    }
  });

  it("throws when clip source file is missing on disk", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-ctx-missing" });
    try {
      const catalogPath = path.join(workDir, "00-scene-catalog.json");
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      catalog.clips[0].sourcePath = path.join(workDir, "missing-clip.MOV");
      fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

      assert.throws(
        () => resolveRenderContext(workDir, recipe),
        /Brak pliku źródłowego dla clipId clip01/,
      );
    } finally {
      cleanupWorkDir(workDir);
    }
  });
});
