import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReviewStep, ensureSpatialIndex, shouldUseSuperDirector, runSuperDirectorDirectPath, SEGMENT_DIRECTOR_CONCURRENCY } from "./agents.js";
import { buildSceneUsageRegistry } from "../../validators/scene-registry.js";
import { writeJson, ARTIFACTS } from "../work-paths.js";
import { loadFixture } from "../../agents/test-helpers.js";
import { createMockOpenAIClient } from "../../agents/test-helpers.js";
import {
  buildMiniDaySuperDirectorPlan,
  buildMiniDaySegmentPartial,
} from "../../test-helpers/mock-openai-client.js";

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

  it("strictReview throws RECIPE_REVIEW_NOT_APPROVED when critic rejects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-strict-review-"));
    try {
      const recipe = loadFixture("recipe-draft.json");
      recipe.sceneUsageRegistry = buildSceneUsageRegistry(recipe);

      writeJson(path.join(dir, ARTIFACTS.abstraction), loadFixture("abstraction.json"));
      writeJson(path.join(dir, ARTIFACTS.timelineIndex), loadFixture("timeline-index.json"));
      writeJson(path.join(dir, ARTIFACTS.sceneCatalog), {
        batchId: "testbatch",
        clips: [{ clipId: "clip01", fileName: "clip01.mp4", durationSec: 120 }],
        scenes: loadFixture("timeline-index.json").scenes,
      });
      writeJson(path.join(dir, ARTIFACTS.clipRegistry), {
        version: "1.0",
        batchId: "testbatch",
        clipRegistry: recipe.clipRegistry,
      });
      writeJson(path.join(dir, ARTIFACTS.topicIndex), {
        version: "1.0",
        batchId: "testbatch",
        topics: [],
      });
      writeJson(path.join(dir, ARTIFACTS.words("clip01")), {
        clipId: "clip01",
        words: loadFixture("timeline-index.json").words,
      });
      writeJson(path.join(dir, ARTIFACTS.spatialIndex), {
        version: "1.0",
        batchId: "testbatch",
        scenes: loadFixture("timeline-index.json").scenes.map((scene) => ({
          sceneId: scene.sceneId,
          clipId: scene.clipId,
          anchors: [],
        })),
      });
      writeJson(path.join(dir, ARTIFACTS.recipeDraft), recipe);

      const client = createMockOpenAIClient([{
        approved: false,
        issues: [{ code: "TEST", severity: "warning", message: "needs polish" }],
        summary: "not approved",
      }]);

      await assert.rejects(
        () => runReviewStep({
          workDir: dir,
          openaiClient: client,
          requiredFormats: ["16:9", "9:16"],
          strictReview: true,
          force: true,
          faceStub: true,
        }),
        (error) => error.code === "RECIPE_REVIEW_NOT_APPROVED",
      );
      assert.equal(fs.existsSync(path.join(dir, ARTIFACTS.recipeFinal)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe("super-director direct path", () => {
  it("shouldUseSuperDirector is false for single-L2 test fixture", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    assert.equal(shouldUseSuperDirector(timelineIndex, abstraction), false);
  });

  it("runSuperDirectorDirectPath merges segment partials", async () => {
    const abstraction = loadFixture("abstraction.json");
    const multiL2 = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        {
          ...abstraction.L2[0],
          segmentId: "seg002",
          summary: "Druga część vloga",
          sceneIds: ["clip01_scene002"],
          startSec: 60,
          endSec: 120,
        },
      ],
    };
    const timelineIndex = loadFixture("timeline-index.json");
    const clipRegistry = [{ clipId: "clip01", sortIndex: 0, durationSec: 120 }];

    const client = createMockOpenAIClient([
      buildMiniDaySuperDirectorPlan(),
      buildMiniDaySegmentPartial("seg001"),
      buildMiniDaySegmentPartial("seg002"),
      { approved: true, issues: [], summary: "ok", crossSegmentNotes: [] },
    ]);

    const { recipe } = await runSuperDirectorDirectPath(client, {
      abstraction: multiL2,
      timelineIndex,
      clipRegistry,
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      keyframesByClip: [],
    });

    assert.ok(recipe.outputs.length >= 1);
    assert.ok(recipe.outputs[0].timeline.length > 0);
  });

  it("runSuperDirectorDirectPath records briefMetrics in directorMetrics", async () => {
    const abstraction = loadFixture("abstraction.json");
    const multiL2 = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        {
          ...abstraction.L2[0],
          segmentId: "seg002",
          summary: "Druga część vloga",
          sceneIds: ["clip01_scene002"],
          startSec: 60,
          endSec: 120,
        },
      ],
    };
    const timelineIndex = loadFixture("timeline-index.json");
    const clipRegistry = [{ clipId: "clip01", sortIndex: 0, durationSec: 120 }];

    const client = createMockOpenAIClient([
      buildMiniDaySuperDirectorPlan(),
      buildMiniDaySegmentPartial("seg001"),
      buildMiniDaySegmentPartial("seg002"),
      { approved: true, issues: [], summary: "ok", crossSegmentNotes: [] },
    ]);

    const { directorMetrics } = await runSuperDirectorDirectPath(client, {
      abstraction: multiL2,
      timelineIndex,
      clipRegistry,
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      keyframesByClip: [],
    });

    assert.equal(directorMetrics.directorPath, "super");
    assert.ok(directorMetrics.briefMetrics);
    assert.equal(directorMetrics.briefMetrics.totals.callCount, 3);
    assert.ok(directorMetrics.briefMetrics.totals.estimatedTokens > 0);
    assert.ok(directorMetrics.briefMetrics.calls.some((call) => call.task === "super_director_route"));
  });

  it("runSuperDirectorDirectPath invokes super critic after stitch validation", async () => {
    const abstraction = loadFixture("abstraction.json");
    const multiL2 = {
      ...abstraction,
      L2: [
        abstraction.L2[0],
        {
          ...abstraction.L2[0],
          segmentId: "seg002",
          summary: "Druga część vloga",
          sceneIds: ["clip01_scene002"],
          startSec: 60,
          endSec: 120,
        },
      ],
    };
    const timelineIndex = loadFixture("timeline-index.json");
    const clipRegistry = [{ clipId: "clip01", sortIndex: 0, durationSec: 120 }];

    const client = createMockOpenAIClient([
      buildMiniDaySuperDirectorPlan(),
      buildMiniDaySegmentPartial("seg001"),
      buildMiniDaySegmentPartial("seg002"),
      { approved: true, issues: [], summary: "arc ok", crossSegmentNotes: ["note-a"] },
    ], { captureRequests: true });

    const { recipe } = await runSuperDirectorDirectPath(client, {
      abstraction: multiL2,
      timelineIndex,
      clipRegistry,
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex: null,
      audioMixDefaults: null,
      perClipAnalysis: null,
      wordIndexes: [],
      keyframesByClip: [],
    });

    const tasks = client.getCapturedRequests().map((request) => {
      const userMessage = request.messages.find((message) => message.role === "user");
      return JSON.parse(userMessage.content).task;
    });

    const segmentDirectorCount = tasks.filter((task) => task === "segment_director_draft").length;
    const superCriticIndex = tasks.lastIndexOf("super_critic_cross_segment");
    const lastSegmentDirectorIndex = tasks.lastIndexOf("segment_director_draft");

    assert.equal(segmentDirectorCount, 2);
    assert.ok(superCriticIndex > lastSegmentDirectorIndex);
    assert.ok(recipe.stitchValidation);
    assert.equal(typeof recipe.stitchValidation.valid, "boolean");

    const superCriticPayload = JSON.parse(
      client.getCapturedRequests()[superCriticIndex].messages.find((m) => m.role === "user").content,
    );
    assert.ok(superCriticPayload.stitchValidation);
    assert.equal(superCriticPayload.stitchValidation.valid, recipe.stitchValidation.valid);
    assert.ok(recipe.superCriticReview);
    assert.equal(recipe.superCriticReview.summary, "arc ok");
    assert.deepEqual(recipe.superPlanNotes, ["note-a"]);
  });

  it("SEGMENT_DIRECTOR_CONCURRENCY is at least 1", () => {
    assert.ok(SEGMENT_DIRECTOR_CONCURRENCY >= 1);
  });
});
