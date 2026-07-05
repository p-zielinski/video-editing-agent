import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planHybridKeyframes,
  speechTimestampsFromWords,
  resolveMaxFramesPerMin,
  runKeyframesStep,
  attachKeyframeImagePaths,
  BROLL_MAX_FRAMES_PER_MIN,
  DEFAULT_MAX_FRAMES_PER_MIN,
} from "./keyframes.js";
import { buildStepConfigFingerprint } from "../../lib/config-fingerprint.js";
import { publishGlobalClipArtifact } from "../../lib/global-cache-step.js";
import { getGlobalCachePath, buildAnalysisCacheKey } from "../../lib/global-analysis-cache.js";
import { writeJson, ARTIFACTS } from "../work-paths.js";

describe("hybrid keyframes", () => {
  it("plans keyframes from scenes and speech", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 30, durationSec: 30 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 30, endSec: 60, durationSec: 30 },
    ];
    const words = [
      { start: 5, end: 5.5 },
      { start: 35, end: 35.5 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words,
      clipId: "clip01",
      durationSec: 60,
      maxFramesPerMin: 6,
    });

    assert.ok(frames.length >= 2);
    assert.ok(frames.some((f) => f.trigger === "speech"));
    assert.ok(frames.some((f) => f.trigger === "scene_cut"));
  });

  it("adds motion keyframes when scene durations diverge", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10, durationSec: 10 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 10, endSec: 40, durationSec: 30 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip01",
      durationSec: 40,
      maxFramesPerMin: 12,
    });

    assert.ok(frames.some((f) => f.trigger === "motion"));
  });

  it("adds motion keyframes when scene cutScore exceeds threshold", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10, durationSec: 10 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 10, endSec: 20, durationSec: 10, cutScore: 0.5 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip01",
      durationSec: 20,
      maxFramesPerMin: 12,
    });

    assert.ok(frames.some((f) => f.trigger === "motion"));
  });

  it("extracts speech timestamps with ±2s window", () => {
    const ts = speechTimestampsFromWords([
      { start: 10, end: 10.5 },
      { start: 20, end: 20.5 },
    ], 2);

    assert.ok(ts.includes(10));
    assert.ok(ts.includes(8));
    assert.ok(ts.includes(12));
    assert.ok(ts.includes(18));
    assert.ok(ts.includes(22));
  });

  it("exports B-roll and default max frames per minute constants", () => {
    assert.equal(BROLL_MAX_FRAMES_PER_MIN, 12);
    assert.equal(DEFAULT_MAX_FRAMES_PER_MIN, 6);
  });

  it("resolveMaxFramesPerMin uses 12 for broll_pool or silent clips", () => {
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { clipRole: "broll_pool" }, words: [] }),
      12,
    );
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { hasSpeech: false }, words: [] }),
      12,
    );
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { clipRole: "aroll_primary", hasSpeech: true }, words: [{ start: 1, end: 2 }] }),
      6,
    );
  });

  it("plans more keyframes for B-roll density than default speech clips", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => ({
      sceneId: `clip02_scene${String(i + 1).padStart(3, "0")}`,
      clipId: "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
    }));

    const dense = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip02",
      durationSec: 80,
      maxFramesPerMin: BROLL_MAX_FRAMES_PER_MIN,
    });
    const sparse = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip02",
      durationSec: 80,
      maxFramesPerMin: DEFAULT_MAX_FRAMES_PER_MIN,
    });

    assert.ok(dense.length > sparse.length);
  });

  it("skips frame extraction for audio_only clips", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-keyframes-"));
    const clipId = "clip_audio";
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "test",
      clips: [{
        clipId,
        sourcePath: "/in/narration.wav",
        fileName: "narration.wav",
        durationSec: 30,
        sortIndex: 0,
        mediaType: "audio_only",
      }],
      scenes: [{
        sceneId: `${clipId}_scene001`,
        clipId,
        sourcePath: "/in/narration.wav",
        startSec: 0,
        endSec: 30,
        durationSec: 30,
        aspectRatio: "other",
        resolution: { w: 0, h: 0 },
        mediaType: "audio_only",
        hasSpeech: true,
      }],
    });
    writeJson(path.join(workDir, ARTIFACTS.words(clipId)), {
      version: "1.0",
      clipId,
      words: [{ wordId: "w1", word: "test", start: 0, end: 1, isFiller: false }],
    });

    const results = await runKeyframesStep({ workDir, extractImages: true });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].keyframes, []);

    const written = JSON.parse(fs.readFileSync(path.join(workDir, ARTIFACTS.keyframes(clipId)), "utf8"));
    assert.equal(written.keyframes.length, 0);

    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("restores keyframes from global cache and re-extracts frame images", async () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vea-keyframes-global-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-keyframes-restore-"));
    const contentHash = "hash-keyframes-global";
    const clipId = "clip02";
    const sourcePath = path.join(workDir, "source.mp4");

    fs.writeFileSync(sourcePath, "fake-video");

    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "batch02",
      clips: [{ clipId, sourcePath, fileName: "source.mp4", contentHash }],
    });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      version: "1.0",
      batchId: "batch02",
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
        aspectRatio: "16:9",
        resolution: { w: 1920, h: 1080 },
      }],
    });
    writeJson(path.join(workDir, ARTIFACTS.words(clipId)), {
      version: "1.0",
      clipId,
      words: [{ wordId: "w1", word: "hello", start: 5, end: 5.5, isFiller: false }],
    });
    writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
      version: "1.0",
      clipRegistry: [{
        clipId,
        clipRole: "aroll_primary",
        hasSpeech: true,
      }],
    });

    const configFingerprint = buildStepConfigFingerprint("keyframes", {
      extractImages: true,
      maxFramesPerMin: DEFAULT_MAX_FRAMES_PER_MIN,
    });

    publishGlobalClipArtifact({
      step: "keyframes",
      contentHash,
      configFingerprint,
      artifact: {
        version: "1.0",
        clipId: "clip01",
        sourceContentHash: contentHash,
        keyframes: [{
          timestampSec: 5,
          sceneId: "clip01_scene001",
          trigger: "speech",
          imagePath: "frames/clip01/frame-0000.jpg",
        }],
      },
      cacheRoot,
    });

    const extractCalls = [];
    const extractFrameAtFn = async (videoPath, timestampSec, outPath) => {
      extractCalls.push({ videoPath, timestampSec, outPath });
      fs.writeFileSync(outPath, "jpeg");
    };

    const results = await runKeyframesStep({
      workDir,
      force: true,
      extractImages: true,
      extractFrameAtFn,
      globalCacheRoot: cacheRoot,
    });

    assert.equal(results.length, 1);
    assert.equal(extractCalls.length, 1);
    assert.equal(extractCalls[0].videoPath, sourcePath);
    assert.equal(extractCalls[0].timestampSec, 5);
    assert.equal(results[0].keyframes[0].sceneId, `${clipId}_scene001`);
    assert.match(results[0].keyframes[0].imagePath, /^frames\/clip02\/frame-0000\.jpg$/);

    const cacheKey = buildAnalysisCacheKey({
      step: "keyframes",
      contentHash,
      configFingerprint,
    });
    assert.ok(fs.existsSync(getGlobalCachePath("keyframes", cacheKey, cacheRoot)));

    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("attachKeyframeImagePaths writes relative image paths", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-kf-attach-"));
    const sourcePath = path.join(workDir, "clip.mp4");
    fs.writeFileSync(sourcePath, "video");

    const frames = await attachKeyframeImagePaths({
      keyframes: [{ timestampSec: 2.5, sceneId: "clip01_scene001", trigger: "speech" }],
      sourcePath,
      workDir,
      clipId: "clip01",
      extractFrameAtFn: async (_src, _ts, outPath) => {
        fs.writeFileSync(outPath, "img");
      },
    });

    assert.equal(frames[0].imagePath, "frames/clip01/frame-0000.jpg");
    assert.ok(fs.existsSync(path.join(workDir, frames[0].imagePath)));

    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
