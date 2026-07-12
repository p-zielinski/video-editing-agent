import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerGeneratedHookClip } from "./register-clip.js";
import { ARTIFACTS, readJson, writeJson } from "../../pipeline/work-paths.js";

describe("registerGeneratedHookClip", () => {
  const workDirs = [];

  afterEach(() => {
    for (const workDir of workDirs.splice(0)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("preserves the actual generator provider in catalog metadata", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hook-register-"));
    workDirs.push(workDir);
    writeJson(path.join(workDir, ARTIFACTS.manifest), { clips: [] });
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      clips: [],
      scenes: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
      clipRegistry: [],
    });

    const sourcePath = path.join(workDir, "stub.mp4");
    fs.writeFileSync(sourcePath, "generated-video-bytes");

    registerGeneratedHookClip(workDir, {
      sourcePath,
      fileName: "stub.mp4",
      durationSec: 5,
      provider: "stub",
    });

    const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
    assert.equal(catalog.clips[0].provider, "stub");
    const manifest = readJson(path.join(workDir, ARTIFACTS.manifest));
    assert.match(manifest.clips[0].contentHash, /^[a-f0-9]{64}$/);
  });
});
