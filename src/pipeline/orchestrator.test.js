import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline, applyEffectiveRequiredFormats } from "./orchestrator.js";
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

  it("applyEffectiveRequiredFormats uses L3 recommendedFormats when not explicit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-orch-formats-"));
    try {
      writeJson(path.join(dir, ARTIFACTS.abstraction), {
        version: "1.0",
        batchId: "fmt01",
        L1: [],
        L2: [],
        L3: {
          sessionSummary: "Short only",
          recommendedFormats: ["9:16"],
        },
      });

      const context = {
        workDir: dir,
        batchContext: { requiredFormats: ["16:9", "9:16"] },
        requiredFormats: ["16:9", "9:16"],
      };

      const effective = applyEffectiveRequiredFormats(context, {
        requiredFormatsExplicit: false,
        userContext: "",
        cliRequiredFormats: ["16:9", "9:16"],
      });

      assert.deepEqual(effective, ["9:16"]);
      assert.equal(context.batchContext.formatsSource, "l3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("twelvelabs step uses stub by default even when TWELVELABS_API_KEY is set", async () => {
    const originalApiKey = process.env.TWELVELABS_API_KEY;
    process.env.TWELVELABS_API_KEY = "test-key";

    const tlBatchId = `orch-tl-${Date.now().toString(36)}`;
    const tlWorkDir = resolveWorkDir(tlBatchId);
    fs.mkdirSync(tlWorkDir, { recursive: true });

    try {
      writeJson(path.join(tlWorkDir, ARTIFACTS.manifest), {
        batchId: tlBatchId,
        clips: [{ clipId: "clip01", sourcePath: "/in/clip01.mp4", fileName: "clip01.mp4" }],
      });
      writeJson(path.join(tlWorkDir, ARTIFACTS.sceneCatalog), {
        batchId: tlBatchId,
        clips: [{ clipId: "clip01", sourcePath: "/in/clip01.mp4", fileName: "clip01.mp4", durationSec: 30 }],
        scenes: [],
      });

      await runPipeline({
        batchId: tlBatchId,
        fromStep: "twelvelabs",
        toStep: "twelvelabs",
        apiKey: "unused",
        force: true,
      });

      const payload = JSON.parse(
        fs.readFileSync(path.join(tlWorkDir, ARTIFACTS.twelvelabs("clip01")), "utf8"),
      );
      assert.equal(payload.indexingStatus, "stub");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.TWELVELABS_API_KEY;
      } else {
        process.env.TWELVELABS_API_KEY = originalApiKey;
      }
      fs.rmSync(tlWorkDir, { recursive: true, force: true });
    }
  });
});
