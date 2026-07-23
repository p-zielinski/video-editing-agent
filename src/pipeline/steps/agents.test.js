import {
  ensureSpatialIndex,
  mergeGeneratedAiSceneIntoTimeline,
  reconstructSuperPlanFromRecipe,
  runAbstractStep,
  runReviewStep,
  runSuperDirectorDirectPath,
  SEGMENT_DIRECTOR_CONCURRENCY,
  shouldUseSuperDirector,
} from "./agents.js";
import { buildSceneUsageRegistry } from "../../validators/scene-registry.js";
import { writeJson, ARTIFACTS } from "../work-paths.js";
import { loadFixture } from "../../agents/test-helpers.js";
import { createMockOpenAIClient } from "../../agents/test-helpers.js";
import {
  buildMiniDaySuperDirectorPlan,
  buildMiniDaySegmentPartial,
} from "../../test-helpers/mock-openai-client.js";
import { StepFailureError } from "../../lib/recovery/errors.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

describe("generated AI scene context", () => {
  it("appends the registered generated scene without mutating the saved timeline", () => {
    const timeline = {
      batchId: "b1",
      clips: [{ clipId: "clip01" }],
      scenes: [{ sceneId: "clip01_scene001", clipId: "clip01" }],
      words: [],
      stats: { totalScenes: 1 },
    };
    const catalog = {
      clips: [{ clipId: "ai_hook_01", durationSec: 5 }],
      scenes: [{
        sceneId: "ai_hook_01_scene001",
        clipId: "ai_hook_01",
        startSec: 0,
        endSec: 5,
        durationSec: 5,
      }],
    };

    const merged = mergeGeneratedAiSceneIntoTimeline(timeline, catalog, {
      status: "succeeded",
      clipId: "ai_hook_01",
      sceneId: "ai_hook_01_scene001",
    });

    assert.equal(merged.scenes.length, 2);
    assert.equal(merged.clips.length, 2);
    assert.equal(merged.stats.totalScenes, 2);
    assert.equal(timeline.scenes.length, 1);
  });
});

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
  it("reconstructs canonical order from recipe-selected segments only", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg_rejected", sceneIds: ["scene_rejected"] },
        { segmentId: "seg_selected_b", sceneIds: ["scene_b"] },
        { segmentId: "seg_selected_a", sceneIds: ["scene_a"] },
      ],
    };
    const recipe = {
      outputs: [
        {
          outputId: "main",
          timeline: [{ videoRef: { sceneId: "scene_a" }, audioRef: { sceneId: "scene_a" } }],
        },
        {
          outputId: "short",
          timeline: [{ videoRef: { sceneId: "scene_b" }, audioRef: { sceneId: "scene_b" } }],
        },
      ],
      narrativeProfile: {
        segments: [
          { l2SegmentId: "seg_rejected", rhythm: "normal" },
          { l2SegmentId: "seg_selected_a", rhythm: "fast" },
          { l2SegmentId: "seg_selected_b", rhythm: "slow" },
        ],
      },
    };

    const reconstructed = reconstructSuperPlanFromRecipe(recipe, abstraction);

    assert.deepEqual(
      reconstructed.segmentPicks.map((pick) => pick.segmentId),
      ["seg_selected_a", "seg_selected_b"],
    );
    assert.deepEqual(
      reconstructed.canonicalSegmentOrder,
      ["seg_selected_b", "seg_selected_a"],
    );
    assert.equal(reconstructed.canonicalSegmentOrder.includes("seg_rejected"), false);
  });

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

describe("runAbstractStep L1 integrity + force cache wipe", () => {
  function makeDiverseL1(sceneIds) {
    return sceneIds.map((sceneId, index) => ({
      sceneId,
      summary: `Unikalne podsumowanie sceny ${sceneId} numer ${index}.`,
      mood: "neutralny",
      keyMoments: [`moment-${index}`],
      brollPotential: 0.4,
      topics: [`topic-${index}`],
      visualQuality: "medium",
      stability: "stable",
    }));
  }

  function seedAbstractWorkDir(workDir, { poisoned = false } = {}) {
    const timeline = loadFixture("timeline-index.json");
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), timeline);
    writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
      version: "1.0",
      batchId: "testbatch",
      clipRegistry: [{ clipId: "clip01", clipRole: "primary", mediaType: "video", hasSpeech: true }],
    });

    const sceneIds = timeline.scenes.map((s) => s.sceneId);
    const abstraction = loadFixture("abstraction.json");
    if (poisoned) {
      abstraction.L1 = sceneIds.map(() => ({
        sceneId: "clip01_scene001",
        summary: "Ten sam zatruty opis spaceru z psem.",
        mood: "spokojny",
        keyMoments: [],
        brollPotential: 0.5,
        topics: ["pies"],
        visualQuality: "medium",
        stability: "stable",
      }));
    }
    writeJson(path.join(workDir, ARTIFACTS.abstraction), abstraction);
    writeJson(path.join(workDir, ARTIFACTS.abstractionL1), abstraction.L1);
    writeJson(path.join(workDir, ARTIFACTS.abstractionL2), abstraction.L2);
    writeJson(path.join(workDir, ARTIFACTS.abstractionL3), abstraction.L3);
    return { timeline, sceneIds };
  }

  it("returns cached abstract when L1 integrity passes", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-abstract-ok-"));
    try {
      seedAbstractWorkDir(workDir, { poisoned: false });
      const result = await runAbstractStep({
        workDir,
        batchId: "testbatch",
        force: false,
        openaiClient: createMockOpenAIClient([]),
      });
      assert.equal(result.L1.length, 2);
      assert.equal(result.L1[0].sceneId, "clip01_scene001");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("invalidates poisoned cached abstract and rebuilds with unique L1", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-abstract-poison-"));
    try {
      seedAbstractWorkDir(workDir, { poisoned: true });
      const manyScenes = Array.from({ length: 8 }, (_, i) => ({
        sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}`,
        clipId: "clip01",
        startSec: i * 10,
        endSec: (i + 1) * 10,
        durationSec: 10,
        aspectRatio: "16:9",
        hasSpeech: true,
      }));
      const visionCaptions = manyScenes.map((scene, i) => ({
        sceneId: scene.sceneId,
        caption: `Widok numer ${i + 1}`,
        timestampSec: scene.startSec + 1,
      }));
      writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
        ...loadFixture("timeline-index.json"),
        scenes: manyScenes,
        visionCaptions,
        stats: { totalDurationSec: 80, totalScenes: 8, totalWords: 3, fillerWordCount: 1 },
      });
      writeJson(path.join(workDir, ARTIFACTS.abstraction), {
        ...loadFixture("abstraction.json"),
        L1: manyScenes.map(() => ({
          sceneId: "clip01_scene001",
          summary: "Ten sam zatruty opis spaceru z psem.",
          mood: "spokojny",
          keyMoments: [],
          brollPotential: 0.5,
          topics: ["pies"],
          visualQuality: "medium",
          stability: "stable",
        })),
      });

      const l1 = makeDiverseL1(manyScenes.map((s) => s.sceneId));
      const l2 = {
        segmentId: "seg001",
        startSec: 0,
        endSec: 80,
        sceneIds: manyScenes.map((s) => s.sceneId),
        summary: "Segment po odbudowie.",
        narrativeRole: "development",
      };
      const l3 = loadFixture("summarizer-l3.json");
      const client = createMockOpenAIClient([...l1, l2, l3]);

      const result = await runAbstractStep({
        workDir,
        batchId: "testbatch",
        force: false,
        openaiClient: client,
      });
      assert.equal(result.L1.length, 8);
      assert.equal(new Set(result.L1.map((s) => s.sceneId)).size, 8);
      assert.equal(new Set(result.L1.map((s) => s.summary)).size, 8);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("--force clears summarizer L1/L2 llm-cache but keeps director caches", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-abstract-force-"));
    try {
      seedAbstractWorkDir(workDir, { poisoned: false });
      const cacheDir = path.join(workDir, "llm-cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      const legacyL1 = path.join(cacheDir, "abstract__summarizerL1.json");
      const directorCache = path.join(cacheDir, "direct__segmentDirector__seg001.json");
      fs.writeFileSync(legacyL1, "{}\n");
      fs.writeFileSync(path.join(cacheDir, "abstract__summarizerL2__seg001.json"), "{}\n");
      fs.writeFileSync(directorCache, "{}\n");

      const timeline = loadFixture("timeline-index.json");
      const l1a = {
        ...loadFixture("summarizer-l1.json"),
        sceneId: "clip01_scene001",
        summary: "Odbudowane L1 A.",
      };
      const l1b = {
        ...loadFixture("summarizer-l1.json"),
        sceneId: "clip01_scene002",
        summary: "Odbudowane L1 B.",
      };
      const l2 = loadFixture("summarizer-l2.json");
      const l3 = loadFixture("summarizer-l3.json");
      const client = createMockOpenAIClient([l1a, l1b, l2, l3]);

      await runAbstractStep({
        workDir,
        batchId: timeline.batchId,
        force: true,
        openaiClient: client,
      });

      // Legacy null-key L1 must stay gone; director caches must survive force wipe.
      assert.equal(fs.existsSync(legacyL1), false);
      assert.ok(fs.existsSync(directorCache));
      // Rebuild writes per-scene L1 keys (not the legacy shared file).
      assert.ok(
        fs.existsSync(path.join(cacheDir, "abstract__summarizerL1__clip01_scene001.json")),
      );
      assert.ok(
        fs.existsSync(path.join(cacheDir, "abstract__summarizerL1__clip01_scene002.json")),
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("throws StepFailureError when L1 stays collapsed after retry", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-abstract-fail-"));
    try {
      const manyScenes = Array.from({ length: 8 }, (_, i) => ({
        sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}`,
        clipId: "clip01",
        startSec: i * 10,
        endSec: (i + 1) * 10,
        durationSec: 10,
        aspectRatio: "16:9",
        hasSpeech: true,
      }));
      const visionCaptions = manyScenes.map((scene, i) => ({
        sceneId: scene.sceneId,
        caption: `Widok numer ${i + 1}`,
        timestampSec: scene.startSec + 1,
      }));
      writeJson(path.join(workDir, ARTIFACTS.timelineIndex), {
        ...loadFixture("timeline-index.json"),
        scenes: manyScenes,
        visionCaptions,
        stats: { totalDurationSec: 80, totalScenes: 8, totalWords: 0, fillerWordCount: 0 },
      });
      writeJson(path.join(workDir, ARTIFACTS.clipRegistry), {
        version: "1.0",
        batchId: "testbatch",
        clipRegistry: [{ clipId: "clip01", clipRole: "primary", mediaType: "video", hasSpeech: true }],
      });

      const poisoned = {
        sceneId: "clip01_scene001",
        summary: "Identyczny zatruty opis dla wszystkich.",
        mood: "spokojny",
        keyMoments: [],
        brollPotential: 0.5,
        topics: ["pies"],
        visualQuality: "medium",
        stability: "stable",
      };
      const l2 = {
        segmentId: "seg001",
        startSec: 0,
        endSec: 80,
        sceneIds: manyScenes.map((s) => s.sceneId),
        summary: "Segment.",
        narrativeRole: "development",
      };
      const l3 = loadFixture("summarizer-l3.json");
      // First build + retry: 8+8 L1, 2 L2, 2 L3
      const responses = [
        ...Array.from({ length: 8 }, () => ({ ...poisoned })),
        l2,
        l3,
        ...Array.from({ length: 8 }, () => ({ ...poisoned })),
        l2,
        l3,
      ];
      const client = createMockOpenAIClient(responses);

      await assert.rejects(
        () => runAbstractStep({
          workDir,
          batchId: "testbatch",
          force: true,
          openaiClient: client,
        }),
        (error) => {
          assert.ok(error instanceof StepFailureError);
          assert.equal(error.step, "abstract");
          assert.match(error.message, /integrity/i);
          const hint = error.failures?.[0]?.recoveryHint ?? "";
          assert.match(hint, /--from-step abstract --to-step abstract/);
          assert.doesNotMatch(hint, /--to-step abstract --force/);
          return true;
        },
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
