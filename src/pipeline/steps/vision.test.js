import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVisionStep } from "./vision.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import { publishGlobalClipArtifact } from "../../lib/global-cache-step.js";
import { getGlobalCachePath, buildAnalysisCacheKey } from "../../lib/global-analysis-cache.js";
import { writeJson, readJson, ARTIFACTS } from "../work-paths.js";

describe("vision step", () => {
  let cacheRoot;
  let previousDisableEnv;

  before(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vea-vision-global-"));
    previousDisableEnv = process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
  });

  after(() => {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    if (previousDisableEnv === undefined) {
      delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    } else {
      process.env.DISABLE_GLOBAL_ANALYSIS_CACHE = previousDisableEnv;
    }
  });

  it("restores vision captions from global cache with remapped sceneIds", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-vision-restore-"));
    const contentHash = "hash-vision-restore";
    const clipId = "clip09";
    const sourcePath = path.join(workDir, "source.mp4");

    fs.writeFileSync(sourcePath, "fake-video");

    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "batch09",
      clips: [{ clipId, sourcePath, fileName: "source.mp4", contentHash }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "batch09",
      clips: [{
        clipId,
        sourcePath,
        fileName: "source.mp4",
        durationSec: 30,
        sortIndex: 0,
      }],
      scenes: [{
        sceneId: `${clipId}_scene001`,
        clipId,
        sourcePath,
        startSec: 0,
        endSec: 30,
        durationSec: 30,
      }],
    });
    writeJson(path.join(workDir, ARTIFACTS.keyframes(clipId)), {
      version: "1.0",
      clipId,
      keyframes: [{
        timestampSec: 5,
        sceneId: `${clipId}_scene001`,
        trigger: "speech",
        imagePath: "frames/clip09/frame-0000.jpg",
      }],
    });

    const configFingerprint = buildStepConfigFingerprint("vision", { stub: true });

    publishGlobalClipArtifact({
      step: "vision",
      contentHash,
      configFingerprint,
      artifact: {
        version: "1.0",
        clipId: "clip01",
        sourceContentHash: contentHash,
        captions: [{
          timestampSec: 5,
          sceneId: "clip01_scene001",
          caption: "Chef plating pasta in a bright kitchen.",
          tags: ["food", "kitchen"],
        }],
      },
      cacheRoot,
    });

    const results = await runVisionStep({
      workDir,
      stub: true,
      force: true,
      globalCacheRoot: cacheRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].clipId, clipId);
    assert.equal(results[0].sourceContentHash, contentHash);
    assert.equal(results[0].captions.length, 1);
    assert.equal(results[0].captions[0].sceneId, `${clipId}_scene001`);
    assert.match(results[0].captions[0].caption, /Chef plating pasta/);

    const written = readJson(path.join(workDir, ARTIFACTS.vision(clipId)));
    assert.equal(written.captions[0].sceneId, `${clipId}_scene001`);

    const cacheKey = buildAnalysisCacheKey({
      step: "vision",
      contentHash,
      configFingerprint,
    });
    assert.ok(fs.existsSync(getGlobalCachePath("vision", cacheKey, cacheRoot)));

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("does not publish empty stub vision artifacts to global cache", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-vision-stub-empty-"));
    const contentHash = "hash-vision-empty";
    const clipId = "clip01";
    const sourcePath = path.join(workDir, "source.mp4");

    fs.writeFileSync(sourcePath, "fake-video");

    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "batch01",
      clips: [{ clipId, sourcePath, fileName: "source.mp4", contentHash }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "batch01",
      clips: [{
        clipId,
        sourcePath,
        fileName: "source.mp4",
        durationSec: 30,
        sortIndex: 0,
      }],
    });
    writeJson(path.join(workDir, ARTIFACTS.keyframes(clipId)), {
      version: "1.0",
      clipId,
      keyframes: [],
    });

    const configFingerprint = buildStepConfigFingerprint("vision", { stub: true });
    const cacheKey = buildAnalysisCacheKey({
      step: "vision",
      contentHash,
      configFingerprint,
    });
    const cachePath = getGlobalCachePath("vision", cacheKey, cacheRoot);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }

    await runVisionStep({
      workDir,
      stub: true,
      force: true,
      globalCacheRoot: cacheRoot,
    });

    assert.ok(!fs.existsSync(cachePath), "empty stub vision should not write global cache");

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
