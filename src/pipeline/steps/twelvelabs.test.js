import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTwelveLabsStep } from "./twelvelabs.js";
import { ARTIFACTS, writeJson, readJson } from "../work-paths.js";

describe("twelvelabs step", () => {
  let workDir;
  const originalApiKey = process.env.TWELVELABS_API_KEY;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-twelvelabs-"));
    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      version: "1.0",
      batchId: "test01",
      clips: [
        { clipId: "clip01", sourcePath: "/in/clip01.mp4", fileName: "clip01.mp4" },
        { clipId: "clip02", sourcePath: "/in/clip02.mp4", fileName: "clip02.mp4" },
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
    fs.rmSync(workDir, { recursive: true, force: true });
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

  it("falls back to stub when live mode requested but API is unimplemented", async () => {
    process.env.TWELVELABS_API_KEY = "test-key-live-fallback";

    const results = await runTwelveLabsStep({
      workDir,
      stub: false,
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
});
