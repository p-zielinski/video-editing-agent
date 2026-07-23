import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processClipTwelveLabs, runTwelveLabsStep } from "./twelvelabs.js";
import { planShortClipFrameTimestamps } from "../../lib/twelvelabs-short-analysis.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import {
  getGlobalCachePath,
  buildAnalysisCacheKey,
} from "../../lib/global-analysis-cache.js";
import { publishGlobalClipArtifact } from "../../lib/global-cache-step.js";
import { ARTIFACTS, writeJson, readJson } from "../work-paths.js";

function touch(filePath, offsetMs = 0) {
  const mtime = (Date.now() - 10_000 + offsetMs) / 1000;
  fs.utimesSync(filePath, mtime, mtime);
}

describe("twelvelabs step", () => {
  let workDir;
  let cacheRoot;
  const originalApiKey = process.env.TWELVELABS_API_KEY;
  let previousDisableEnv;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-twelvelabs-"));
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vea-twelvelabs-global-"));
    previousDisableEnv = process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "test01",
      clips: [
        { clipId: "clip01", sourcePath: "/in/clip01.mp4", fileName: "clip01.mp4", contentHash: "hash-tl-01" },
        { clipId: "clip02", sourcePath: "/in/clip02.mp4", fileName: "clip02.mp4", contentHash: "hash-tl-02" },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "test01",
      clips: [
        { clipId: "clip01", sourcePath: "/in/clip01.mp4", fileName: "clip01.mp4", durationSec: 30 },
        { clipId: "clip02", sourcePath: "/in/clip02.mp4", fileName: "clip02.mp4", durationSec: 45 },
      ],
    });
  });

  after(() => {
    if (originalApiKey === undefined) {
      delete process.env.TWELVELABS_API_KEY;
    } else {
      process.env.TWELVELABS_API_KEY = originalApiKey;
    }
    if (previousDisableEnv === undefined) {
      delete process.env.DISABLE_GLOBAL_ANALYSIS_CACHE;
    } else {
      process.env.DISABLE_GLOBAL_ANALYSIS_CACHE = previousDisableEnv;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("stub mode writes per-clip artifacts with empty chapters and moments", async () => {
    delete process.env.TWELVELABS_API_KEY;

    const results = await runTwelveLabsStep({ workDir, stub: true, force: true });

    assert.equal(results.length, 2);
    for (const clipId of ["clip01", "clip02"]) {
      const artifactPath = path.join(workDir, ARTIFACTS.twelvelabs(clipId));
      assert.ok(fs.existsSync(artifactPath), `expected artifact for ${clipId}`);

      const payload = readJson(artifactPath);
      assert.equal(payload.version, "1.0");
      assert.equal(payload.clipId, clipId);
      assert.equal(payload.indexingStatus, "stub");
      assert.deepEqual(payload.chapters, []);
      assert.deepEqual(payload.moments, []);
    }
  });

  it("uses cache when artifact is fresh and force is false", async () => {
    const first = await runTwelveLabsStep({ workDir, stub: true, force: false });
    const second = await runTwelveLabsStep({ workDir, stub: true, force: false });

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.equal(second[0].clipId, "clip01");
    assert.equal(second[0].indexingStatus, "stub");
  });

  it("defaults to stub when TWELVELABS_API_KEY is unset", async () => {
    delete process.env.TWELVELABS_API_KEY;

    const results = await runTwelveLabsStep({ workDir, force: true });

    assert.equal(results[0].indexingStatus, "stub");
  });

  it("attempts live when TWELVELABS_API_KEY is set (falls back to stub on API error)", async () => {
    process.env.TWELVELABS_API_KEY = "test-key-live-fallback";

    const results = await runTwelveLabsStep({
      workDir,
      force: true,
      apiKey: "test-key-live-fallback",
    });

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.indexingStatus, "stub");
      assert.deepEqual(result.chapters, []);
      assert.deepEqual(result.moments, []);
    }
  });

  it("short clips use frame_analysis via GPT when under min duration", async () => {
    process.env.TWELVELABS_API_KEY = "test-key-short";
    const shortDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-tl-short-"));
    try {
      writeJson(path.join(shortDir, ARTIFACTS.manifest), {
        version: "1.0",
        batchId: "short01",
        clips: [{
          clipId: "clip01",
          sourcePath: "/in/short.mp4",
          fileName: "short.mp4",
          contentHash: "hash-short",
          durationSec: 2,
        }],
      });
      writeJson(path.join(shortDir, ARTIFACTS.sceneCatalog), {
        version: "1.0",
        batchId: "short01",
        clips: [{
          clipId: "clip01",
          sourcePath: "/in/short.mp4",
          fileName: "short.mp4",
          durationSec: 2,
        }],
      });

      const result = await processClipTwelveLabs({
        workDir: shortDir,
        clip: { clipId: "clip01", sourcePath: "/in/short.mp4", durationSec: 2 },
        manifest: readJson(path.join(shortDir, ARTIFACTS.manifest)),
        useStub: false,
        force: true,
        apiKey: "test-key-short",
        openaiApiKey: "sk-test",
        configFingerprint: buildStepConfigFingerprint("twelvelabs", {
          useStub: false,
          twelvelabsLive: true,
        }),
        globalCacheDisabled: true,
        analyzeShortClipWithGptFn: async () => ({
          indexingStatus: "frame_analysis",
          clipSummary: "Mountain ridge",
          chapters: [{ startSec: 0, endSec: 2, title: "Ridge" }],
          moments: [{ startSec: 0, endSec: 2, description: "Wide vista" }],
          editorial: { summary: "Mountain ridge", mood: "reflective" },
        }),
      });

      assert.equal(result.indexingStatus, "frame_analysis");
      assert.equal(result.clipSummary, "Mountain ridge");
      assert.equal(result.moments[0].description, "Wide vista");
    } finally {
      fs.rmSync(shortDir, { recursive: true, force: true });
    }
  });

  it("planShortClipFrameTimestamps returns mid for ultra-short clips", () => {
    assert.deepEqual(planShortClipFrameTimestamps(1.2), [0.6]);
    assert.equal(planShortClipFrameTimestamps(3).length, 3);
  });

  it("rebuilds stub artifacts when switching from stub to live mode", async () => {
    delete process.env.TWELVELABS_API_KEY;
    await runTwelveLabsStep({ workDir, stub: true, force: true });

    const artifactPath = path.join(workDir, ARTIFACTS.twelvelabs("clip01"));
    const beforeMtime = fs.statSync(artifactPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    process.env.TWELVELABS_API_KEY = "test-key-stub-to-live";
    await runTwelveLabsStep({
      workDir,
      force: false,
      apiKey: "test-key-stub-to-live",
    });

    const afterMtime = fs.statSync(artifactPath).mtimeMs;
    assert.ok(afterMtime > beforeMtime, "expected stub artifact to be rebuilt in live mode");
  });

  it("rebuilds version 1.0 twelvelabs artifacts", async () => {
    delete process.env.TWELVELABS_API_KEY;

    const manifestPath = path.join(workDir, ARTIFACTS.manifest);
    const sceneCatalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
    const artifactPath = path.join(workDir, ARTIFACTS.twelvelabs("clip01"));

    writeJson(artifactPath, {
      version: "1.0",
      clipId: "clip01",
      indexingStatus: "indexed",
      sourceContentHash: "legacy-hash",
      chapters: [{ startSec: 0, endSec: 10, title: "Stale chapter" }],
      moments: [{ startSec: 1, endSec: 5, description: "Stale moment" }],
    });
    touch(manifestPath, 0);
    touch(sceneCatalogPath, 0);
    touch(artifactPath, 5000);

    await runTwelveLabsStep({ workDir, stub: true, force: false });

    const payload = readJson(artifactPath);
    assert.equal(payload.version, "1.0");
    assert.equal(payload.indexingStatus, "stub");
    assert.deepEqual(payload.chapters, []);
    assert.deepEqual(payload.moments, []);
  });

  it("does not publish stub artifacts to global cache", async () => {
    delete process.env.TWELVELABS_API_KEY;

    const configFingerprint = buildStepConfigFingerprint("twelvelabs", {
      useStub: true,
      twelvelabsLive: false,
    });
    const cacheKey = buildAnalysisCacheKey({
      step: "twelvelabs",
      contentHash: "hash-tl-01",
      configFingerprint,
    });
    const cachePath = getGlobalCachePath("twelvelabs", cacheKey, cacheRoot);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }

    await runTwelveLabsStep({ workDir, stub: true, force: true, globalCacheRoot: cacheRoot });

    assert.ok(!fs.existsSync(cachePath), "stub run should not write global cache");
  });

  it("restores indexed twelvelabs artifacts from global cache", async () => {
    const contentHash = "hash-tl-restore";
    const configFingerprint = buildStepConfigFingerprint("twelvelabs", {
      useStub: false,
      twelvelabsLive: true,
    });

    publishGlobalClipArtifact({
      step: "twelvelabs",
      contentHash,
      configFingerprint,
      artifact: {
        version: "1.1",
        clipId: "clip01",
        sourceContentHash: contentHash,
        indexingStatus: "indexed",
        twelveLabsAssetId: "asset-global-1",
        chapters: [{ startSec: 0, endSec: 10, title: "Intro" }],
        moments: [{ startSec: 2, endSec: 8, description: "Chef plating" }],
      },
      cacheRoot,
    });

    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "test01",
      clips: [
        { clipId: "clip09", sourcePath: "/in/clip09.mp4", fileName: "clip09.mp4", contentHash },
      ],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "test01",
      clips: [
        { clipId: "clip09", sourcePath: "/in/clip09.mp4", fileName: "clip09.mp4", durationSec: 30 },
      ],
    });

    process.env.TWELVELABS_API_KEY = "test-key-should-not-call";

    const results = await runTwelveLabsStep({
      workDir,
      force: true,
      apiKey: "test-key-should-not-call",
      globalCacheRoot: cacheRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].clipId, "clip09");
    assert.equal(results[0].indexingStatus, "indexed");
    assert.equal(results[0].twelveLabsAssetId, "asset-global-1");
    assert.equal(results[0].moments[0].description, "Chef plating");

    const artifactPath = path.join(workDir, ARTIFACTS.twelvelabs("clip09"));
    const written = readJson(artifactPath);
    assert.equal(written.sourceContentHash, contentHash);
  });
});
