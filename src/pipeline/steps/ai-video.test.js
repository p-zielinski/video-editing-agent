import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeGeneratedHookWithTwelveLabs,
  canReuseAiVideoArtifact,
  resolveAiVideoExecution,
  runAiVideoStep,
} from "./ai-video.js";

describe("AI video execution mode", () => {
  const workDirs = [];

  afterEach(() => {
    for (const workDir of workDirs.splice(0)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses stub only when explicitly requested", () => {
    assert.deepEqual(resolveAiVideoExecution({
      useStub: true,
      env: {},
    }), {
      useStub: true,
      model: "stub",
      credentialsAvailable: false,
    });

    assert.deepEqual(resolveAiVideoExecution({
      env: { AI_VIDEO_STUB: "1" },
    }), {
      useStub: true,
      model: "stub",
      credentialsAvailable: false,
    });
  });

  it("does not silently fall back to stub when credentials are missing", () => {
    assert.deepEqual(resolveAiVideoExecution({ env: {} }), {
      useStub: false,
      model: "kling-v3",
      credentialsAvailable: false,
    });
  });

  it("recognizes configured live credentials and model", () => {
    assert.deepEqual(resolveAiVideoExecution({
      env: {
        KLING_ACCESS_KEY: "access",
        KLING_SECRET_KEY: "secret",
        KLING_VIDEO_MODEL: "kling-v3-custom",
      },
    }), {
      useStub: false,
      model: "kling-v3-custom",
      credentialsAvailable: true,
    });
  });

  it("reuses cache only for the same stub/live mode and model", () => {
    assert.equal(canReuseAiVideoArtifact(
      { status: "succeeded", stub: true, model: "stub" },
      { useStub: true, model: "stub" },
    ), true);
    assert.equal(canReuseAiVideoArtifact(
      { status: "succeeded", stub: true, model: "stub" },
      { useStub: false, model: "kling-v3" },
    ), false);
    assert.equal(canReuseAiVideoArtifact(
      { status: "succeeded", stub: false, model: "kling-v2-6" },
      { useStub: false, model: "kling-v3" },
    ), false);
    assert.equal(canReuseAiVideoArtifact(
      {
        status: "succeeded",
        stub: false,
        model: "kling-v3",
        twelveLabsAnalysis: { mode: "stub" },
      },
      { useStub: false, model: "kling-v3" },
      { twelveLabsMode: "live" },
    ), false);
    assert.equal(canReuseAiVideoArtifact(
      {
        status: "succeeded",
        stub: false,
        model: "kling-v3",
        twelveLabsAnalysis: { mode: "live", status: "unavailable" },
      },
      { useStub: false, model: "kling-v3" },
      { twelveLabsMode: "live" },
    ), false);
  });

  it("returns an explicit configuration failure before reading generation inputs", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-video-no-creds-"));
    workDirs.push(workDir);

    const result = await runAiVideoStep({
      workDir,
      batchContext: { aiVideoEnabled: true },
      env: {},
    });

    assert.equal(result.status, "failed");
    assert.equal(result.stub, false);
    assert.equal(result.model, "kling-v3");
    assert.match(result.reason, /KLING_ACCESS_KEY/);
  });

  it("analyzes a generated Kling hook with the existing TwelveLabs clip path", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-video-tl-"));
    workDirs.push(workDir);
    fs.writeFileSync(path.join(workDir, "00-manifest.json"), JSON.stringify({
      clips: [{
        clipId: "ai_hook_01",
        sourcePath: "/generated/ai_hook_01.mp4",
        contentHash: "hook-hash",
      }],
    }));
    const calls = [];

    const analysis = await analyzeGeneratedHookWithTwelveLabs({
      workDir,
      generated: {
        status: "succeeded",
        provider: "kling",
        clipId: "ai_hook_01",
        videoPath: "/generated/ai_hook_01.mp4",
      },
      useStub: false,
      apiKey: "tl-key",
      processClip: async (options) => {
        calls.push(options);
        return {
          indexingStatus: "indexed",
          clipSummary: "Dynamiczne przejście rowerzysty na szczyt.",
          editorial: { mood: "triumphant" },
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].clip.clipId, "ai_hook_01");
    assert.equal(calls[0].clip.sourcePath, "/generated/ai_hook_01.mp4");
    assert.equal(calls[0].force, false);
    assert.equal(analysis.status, "succeeded");
    assert.equal(analysis.clipSummary, "Dynamiczne przejście rowerzysty na szczyt.");
  });

  it("marks generated-hook understanding unavailable when TwelveLabs returns stub", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-video-tl-stub-"));
    workDirs.push(workDir);
    fs.writeFileSync(path.join(workDir, "00-manifest.json"), JSON.stringify({
      clips: [{ clipId: "ai_hook_01", sourcePath: "/generated/hook.mp4" }],
    }));

    const analysis = await analyzeGeneratedHookWithTwelveLabs({
      workDir,
      generated: {
        status: "succeeded",
        provider: "kling",
        clipId: "ai_hook_01",
        videoPath: "/generated/hook.mp4",
      },
      useStub: true,
      processClip: async () => ({ indexingStatus: "stub", moments: [] }),
    });

    assert.equal(analysis.status, "unavailable");
    assert.equal(analysis.reason, "twelvelabs_stub");
  });
});
