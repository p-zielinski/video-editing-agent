import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "./orchestrator.js";
import { ensureSpatialIndex } from "./steps/agents.js";
import { SpatialIndexSchema } from "../schemas/spatial-index.js";
import { writeJson, ARTIFACTS, resolveWorkDir } from "./work-paths.js";
import { loadFixture } from "../agents/test-helpers.js";

describe("orchestrator", () => {
  let workDir;
  let batchId;

  before(() => {
    batchId = `orch-${Date.now().toString(36)}`;
    workDir = resolveWorkDir(batchId);
    fs.mkdirSync(workDir, { recursive: true });

    const timelineIndex = loadFixture("timeline-index.json");
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), timelineIndex);
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: timelineIndex.batchId,
      clips: timelineIndex.clips ?? [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
      scenes: timelineIndex.scenes,
    });
    writeJson(path.join(workDir, ARTIFACTS.manifest), {
      batchId: timelineIndex.batchId,
      createdAt: new Date().toISOString(),
    });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("runs spatial_index step from pre-built fixture workDir", async () => {
    const result = await runPipeline({
      batchId,
      fromStep: "spatial_index",
      toStep: "spatial_index",
      apiKey: "unused",
      userContext: "",
      faceStub: true,
    });

    assert.equal(result.batchId, batchId);
    const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
    assert.equal(fs.existsSync(spatialPath), true);

    const spatialIndex = SpatialIndexSchema.parse(JSON.parse(fs.readFileSync(spatialPath, "utf8")));
    assert.ok(Array.isArray(spatialIndex.scenes));
    assert.ok(spatialIndex.builtFrom);
    assert.equal(typeof spatialIndex.builtFrom.objectDetectionCount, "number");
  });

  it("ensureSpatialIndex rebuilds stale 05c when objects are newer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-orch-stale-"));
    try {
      const timelineIndex = loadFixture("timeline-index.json");
      writeJson(path.join(dir, ARTIFACTS.timelineIndex), timelineIndex);
      writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
        batchId: timelineIndex.batchId,
        clips: [{ clipId: "clip01" }],
        scenes: timelineIndex.scenes,
      });
      writeJson(path.join(dir, ARTIFACTS.objects("clip01")), {
        version: "1.0",
        clipId: "clip01",
        detections: timelineIndex.objectDetections ?? [],
      });
      writeJson(path.join(dir, ARTIFACTS.spatialIndex), {
        version: "1.0",
        batchId: timelineIndex.batchId,
        scenes: [{ sceneId: "stale_scene", clipId: "clip01", anchors: [] }],
      });

      const base = Date.now() - 10_000;
      const spatialPath = path.join(dir, ARTIFACTS.spatialIndex);
      const timelinePath = path.join(dir, ARTIFACTS.timelineIndex);
      const objectsPath = path.join(dir, ARTIFACTS.objects("clip01"));
      fs.utimesSync(spatialPath, base / 1000, base / 1000);
      fs.utimesSync(timelinePath, base / 1000, base / 1000);
      fs.utimesSync(objectsPath, (base + 5000) / 1000, (base + 5000) / 1000);

      const rebuilt = await ensureSpatialIndex(dir, { faceStub: true });
      assert.notEqual(rebuilt.scenes[0]?.sceneId, "stale_scene");
      assert.ok(rebuilt.scenes.length >= 1);
      assert.ok(rebuilt.builtFrom);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
