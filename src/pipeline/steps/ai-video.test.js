import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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
});
