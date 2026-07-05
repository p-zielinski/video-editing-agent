import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStepConfigFingerprint } from "./config-fingerprint.js";
import { writeGlobalAnalysisCache } from "./global-analysis-cache.js";
import {
  maybeUseGlobalClipCache,
  publishGlobalClipArtifact,
  tryRestoreGlobalClipArtifact,
} from "./global-cache-step.js";

describe("global-cache-step", () => {
  let cacheRoot;
  let previousDisableEnv;

  before(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vea-global-cache-step-"));
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

  it("publishGlobalClipArtifact and tryRestoreGlobalClipArtifact round-trip words", () => {
    const contentHash = "hash-words-roundtrip";
    const configFingerprint = buildStepConfigFingerprint("words", {});
    const artifact = {
      version: "1.0",
      clipId: "clip01",
      sourceContentHash: contentHash,
      durationSec: 5,
      words: [
        {
          wordId: "clip01_w00000",
          word: "hello",
          start: 0,
          end: 0.5,
          isFiller: false,
        },
      ],
    };

    const written = publishGlobalClipArtifact({
      step: "words",
      contentHash,
      configFingerprint,
      artifact,
      cacheRoot,
    });
    assert.ok(written);

    const restored = tryRestoreGlobalClipArtifact({
      step: "words",
      contentHash,
      configFingerprint,
      clipId: "clip02",
      cacheRoot,
    });

    assert.equal(restored.clipId, "clip02");
    assert.equal(restored.words[0].wordId, "clip02_w00000");
    assert.equal(restored.words[0].word, "hello");
    assert.equal(restored.sourceContentHash, undefined);
  });

  it("maybeUseGlobalClipCache returns null when disabled or missing contentHash", () => {
    const configFingerprint = buildStepConfigFingerprint("audioAnalysis", { stub: true });

    assert.equal(
      maybeUseGlobalClipCache({
        enabled: false,
        step: "audioAnalysis",
        contentHash: "hash-a",
        configFingerprint,
        clipId: "clip01",
        cacheRoot,
      }),
      null,
    );

    assert.equal(
      maybeUseGlobalClipCache({
        enabled: true,
        step: "audioAnalysis",
        contentHash: null,
        configFingerprint,
        clipId: "clip01",
        cacheRoot,
      }),
      null,
    );
  });

  it("maybeUseGlobalClipCache restores audioAnalysis artifacts", () => {
    const contentHash = "hash-audio";
    const configFingerprint = buildStepConfigFingerprint("audioAnalysis", { stub: true });
    const artifact = {
      version: "1.0",
      clipId: "clip01",
      sourceContentHash: contentHash,
      durationSec: 30,
      voiceLufs: -18,
      energyCurve: [],
      silenceGaps: [],
      beats: [{ timeSec: 1, strength: 0.8 }],
      cutSuggestions: [],
      musicBedRecommendation: null,
      estimatedBpm: 120,
      analysisMode: "stub",
      audioEvents: [],
      editorialTags: [],
      eventDetectionMode: "stub",
    };

    publishGlobalClipArtifact({
      step: "audioAnalysis",
      contentHash,
      configFingerprint,
      artifact,
      cacheRoot,
    });

    const restored = maybeUseGlobalClipCache({
      enabled: true,
      step: "audioAnalysis",
      contentHash,
      configFingerprint,
      clipId: "clip09",
      cacheRoot,
    });

    assert.equal(restored.clipId, "clip09");
    assert.equal(restored.estimatedBpm, 120);
    assert.equal(restored.eventDetectionMode, "stub");
  });

  it("publishGlobalClipArtifact returns null without contentHash", () => {
    assert.equal(
      publishGlobalClipArtifact({
        step: "words",
        contentHash: "",
        configFingerprint: buildStepConfigFingerprint("words", {}),
        artifact: { clipId: "clip01", version: "1.0", words: [] },
        cacheRoot,
      }),
      null,
    );
  });

  it("tryRestoreGlobalClipArtifact uses cachedClipIdFromData for scene remapping", () => {
    const contentHash = "hash-kf";
    const configFingerprint = buildStepConfigFingerprint("keyframes", {});
    const canonical = {
      version: "1.0",
      durationSec: 10,
      keyframes: [{ timestampSec: 1, sceneId: "scene001", trigger: "speech" }],
    };

    writeGlobalAnalysisCache({
      step: "keyframes",
      contentHash,
      configFingerprint,
      data: canonical,
      meta: { cachedClipId: "clip01" },
      cacheRoot,
    });

    const restored = tryRestoreGlobalClipArtifact({
      step: "keyframes",
      contentHash,
      configFingerprint,
      clipId: "clip03",
      cachedClipIdFromData: "clip01",
      cacheRoot,
    });

    assert.equal(restored.keyframes[0].sceneId, "clip03_scene001");
  });

  it("tryRestoreGlobalClipArtifact remaps vision caption sceneIds", () => {
    const contentHash = "hash-vision";
    const configFingerprint = buildStepConfigFingerprint("vision", { stub: true });
    const canonical = {
      version: "1.0",
      captions: [{
        timestampSec: 2,
        sceneId: "scene001",
        caption: "Wide shot of a city street.",
        tags: ["urban"],
      }],
    };

    writeGlobalAnalysisCache({
      step: "vision",
      contentHash,
      configFingerprint,
      data: canonical,
      meta: { cachedClipId: "clip01" },
      cacheRoot,
    });

    const restored = tryRestoreGlobalClipArtifact({
      step: "vision",
      contentHash,
      configFingerprint,
      clipId: "clip05",
      cacheRoot,
    });

    assert.equal(restored.clipId, "clip05");
    assert.equal(restored.captions[0].sceneId, "clip05_scene001");
    assert.equal(restored.captions[0].caption, "Wide shot of a city street.");
  });
});
