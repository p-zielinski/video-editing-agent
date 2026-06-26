import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReviewStep, ensureSpatialIndex } from "./agents.js";
import { buildSceneUsageRegistry } from "../../validators/scene-registry.js";
import { writeJson, ARTIFACTS } from "../work-paths.js";
import { loadFixture } from "../../agents/test-helpers.js";

describe("review step", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-review-"));
    const recipe = loadFixture("recipe-draft.json");
    recipe.sceneUsageRegistry = buildSceneUsageRegistry(recipe);

    writeJson(path.join(workDir, ARTIFACTS.abstraction), loadFixture("abstraction.json"));
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), loadFixture("timeline-index.json"));
    writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
      batchId: "testbatch",
      clips: [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
      scenes: loadFixture("timeline-index.json").scenes,
    });
    writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
      version: "1.0",
      batchId: "testbatch",
      clipRegistry: recipe.clipRegistry,
    });
    writeJson(path.join(workDir, ARTIFACTS.topicIndex), {
      version: "1.0",
      batchId: "testbatch",
      topics: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.words("clip01")), {
      clipId: "clip01",
      words: loadFixture("timeline-index.json").words,
    });
    writeJson(path.join(workDir, ARTIFACTS.spatialIndex), {
      version: "1.0",
      batchId: "testbatch",
      scenes: loadFixture("timeline-index.json").scenes.map((scene) => ({
        sceneId: scene.sceneId,
        clipId: scene.clipId,
        anchors: [],
      })),
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
    writeJson(path.join(workDir, ARTIFACTS.review), {
      version: "1.0",
      batchId: recipe.batchId,
      iteration: 1,
      approved: true,
      issues: [],
      summary: "cached review",
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

    const base = Date.now() - 10_000;
    fs.utimesSync(path.join(workDir, ARTIFACTS.recipeDraft), base / 1000, base / 1000);
    fs.utimesSync(path.join(workDir, ARTIFACTS.review), (base + 1000) / 1000, (base + 1000) / 1000);
    fs.utimesSync(path.join(workDir, ARTIFACTS.recipeFinal), (base + 5000) / 1000, (base + 5000) / 1000);
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("skips review when valid final recipe already exists", async () => {
    const result = await runReviewStep({
      workDir,
      apiKey: "test-key-should-not-be-used",
      requiredFormats: ["16:9", "9:16"],
      force: false,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.finalWritten, false);
    assert.equal(result.recipe.outputs.length, 2);
    assert.equal(result.review.summary, "cached review");
  });

  it("ensureSpatialIndex creates 05c when missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-spatial-"));
    try {
      const timelineIndex = loadFixture("timeline-index.json");
      writeJson(path.join(dir, ARTIFACTS.timelineIndex), timelineIndex);
      writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
        batchId: timelineIndex.batchId,
        clips: [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
        scenes: timelineIndex.scenes,
      });
      assert.equal(fs.existsSync(path.join(dir, ARTIFACTS.spatialIndex)), false);

      const spatialIndex = await ensureSpatialIndex(dir, { faceStub: true });
      assert.equal(fs.existsSync(path.join(dir, ARTIFACTS.spatialIndex)), true);
      assert.ok(Array.isArray(spatialIndex.scenes));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensureSpatialIndex rebuilds when objects artifact is newer (stale)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-spatial-obj-stale-"));
    try {
      const timelineIndex = loadFixture("timeline-index.json");
      writeJson(path.join(dir, ARTIFACTS.timelineIndex), timelineIndex);
      writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
        batchId: timelineIndex.batchId,
        clips: [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
        scenes: timelineIndex.scenes,
      });
      writeJson(path.join(dir, ARTIFACTS.objects("clip01")), {
        version: "1.0",
        clipId: "clip01",
        detections: timelineIndex.objectDetections ?? [],
      });
      writeJson(path.join(dir, ARTIFACTS.spatialIndex), {
        version: "1.0",
        batchId: "old",
        scenes: [{ sceneId: "obsolete", clipId: "clip01", anchors: [] }],
      });

      const base = Date.now() - 10_000;
      fs.utimesSync(path.join(dir, ARTIFACTS.spatialIndex), base / 1000, base / 1000);
      fs.utimesSync(path.join(dir, ARTIFACTS.timelineIndex), base / 1000, base / 1000);
      fs.utimesSync(
        path.join(dir, ARTIFACTS.objects("clip01")),
        (base + 5000) / 1000,
        (base + 5000) / 1000,
      );

      const spatialIndex = await ensureSpatialIndex(dir, { faceStub: true });
      assert.notEqual(spatialIndex.scenes[0]?.sceneId, "obsolete");
      assert.ok(spatialIndex.scenes.length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensureSpatialIndex rebuilds when timeline index is newer (stale)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-spatial-stale-"));
    try {
      const timelineIndex = loadFixture("timeline-index.json");
      writeJson(path.join(dir, ARTIFACTS.timelineIndex), timelineIndex);
      writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
        batchId: timelineIndex.batchId,
        clips: [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
        scenes: timelineIndex.scenes,
      });
      writeJson(path.join(dir, ARTIFACTS.spatialIndex), {
        version: "1.0",
        batchId: "old",
        scenes: [{ sceneId: "obsolete", clipId: "clip01", anchors: [] }],
      });

      const base = Date.now() - 10_000;
      fs.utimesSync(
        path.join(dir, ARTIFACTS.spatialIndex),
        base / 1000,
        base / 1000,
      );
      fs.utimesSync(
        path.join(dir, ARTIFACTS.timelineIndex),
        (base + 5000) / 1000,
        (base + 5000) / 1000,
      );

      const spatialIndex = await ensureSpatialIndex(dir, { faceStub: true });
      assert.notEqual(spatialIndex.scenes[0]?.sceneId, "obsolete");
      assert.ok(spatialIndex.scenes.length > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
