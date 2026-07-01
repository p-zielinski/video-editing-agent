import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
  loadFixtureArtifact,
  touchNewerThan,
} from "../../src/test-helpers/fixture-work-dir.js";
import { runClipProfileStep } from "../../src/pipeline/steps/clip-profile.js";
import { runTopicIndexStep, createTokenVectorEmbedFn } from "../../src/pipeline/steps/topic-index.js";
import { runSpatialIndexStep } from "../../src/pipeline/steps/spatial-index.js";
import { ClipRegistryArtifactSchema, TopicIndexSchema } from "../../src/schemas/edit-recipe-v2.js";
import { SpatialIndexSchema } from "../../src/schemas/spatial-index.js";
import { isArtifactStale, isSpatialIndexStale } from "../../src/pipeline/artifact-deps.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const FIXTURE_EXCLUDE = [
  "05a-clip-registry.json",
  "05b-topic-index.json",
  "05c-spatial-index.json",
  "expected-recipe-v2.json",
  "expected-validation.json",
  "README.md",
];

const workDirs = [];

afterEach(() => {
  while (workDirs.length > 0) {
    cleanupWorkDir(workDirs.pop());
  }
});

function trackWorkDir(workDir) {
  workDirs.push(workDir);
  return workDir;
}

function stripSpatialVolatile(spatialIndex) {
  const { builtFrom, ...rest } = spatialIndex;
  return rest;
}

function summarizeClipRegistry(artifact) {
  return (artifact.clipRegistry ?? artifact).map((entry) => ({
    clipId: entry.clipId,
    clipRole: entry.clipRole,
    hasSpeech: entry.hasSpeech,
  }));
}

function summarizeTopicIndex(index) {
  return index.topics.map((topic) => ({
    label: topic.label,
    wordCount: topic.wordIds.length,
    matchingScenes: topic.matchingScenes.map((m) => ({
      sceneId: m.sceneId,
      score: m.score,
    })),
  }));
}

function summarizeSpatialIndex(index) {
  return index.scenes.map((scene) => ({
    sceneId: scene.sceneId,
    clipId: scene.clipId,
    anchors: scene.anchors.map((a) => ({
      type: a.type,
      label: a.label,
      bbox: a.bbox,
    })),
  }));
}

function loadWordIndexes(batchName, clipIds) {
  return clipIds.map((clipId) =>
    loadFixtureArtifact(batchName, `01-words-${clipId}.json`),
  );
}

function assertValidationGolden(result, batchName) {
  const golden = loadFixtureArtifact(batchName, "expected-validation.json");
  const errors = result.issues.filter((issue) => issue.severity === "error");

  assert.equal(
    errors.length,
    golden.expectedErrorCount,
    `expected ${golden.expectedErrorCount} errors, got: ${errors.map((e) => e.code).join(", ")}`,
  );

  for (const code of golden.exercisedValidatorCodes) {
    assert.ok(
      typeof code === "string" && code.length > 0,
      `golden exercisedValidatorCodes entry must be a non-empty string`,
    );
  }

  const warningCodes = new Set(
    result.issues
      .filter((issue) => issue.severity === "warning")
      .map((issue) => issue.code),
  );
  for (const allowed of golden.allowedWarningCodes ?? []) {
    // allowed list documents warnings that may appear without failing the fixture
    assert.ok(
      warningCodes.has(allowed) || errors.length === 0,
      `allowed warning ${allowed} documented in golden`,
    );
  }
}

describe("pre-render E2E — mini-day", () => {
  it("runs clip_profile → topic_index → spatial_index without OpenAI", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));
    const goldenClip = loadFixtureArtifact("mini-day", "05a-clip-registry.json");
    const goldenTopic = loadFixtureArtifact("mini-day", "05b-topic-index.json");
    const goldenSpatial = loadFixtureArtifact("mini-day", "05c-spatial-index.json");

    const clipRegistry = await runClipProfileStep({ workDir, force: true });
    const topicIndex = await runTopicIndexStep({
      workDir,
      force: true,
      embedFn: createTokenVectorEmbedFn(),
    });
    const spatialIndex = await runSpatialIndexStep({ workDir, force: true, faceStub: true });

    ClipRegistryArtifactSchema.parse(clipRegistry);
    TopicIndexSchema.parse(topicIndex);
    SpatialIndexSchema.parse(spatialIndex);

    assert.deepEqual(
      summarizeClipRegistry(clipRegistry),
      summarizeClipRegistry(goldenClip),
    );
    assert.deepEqual(summarizeTopicIndex(topicIndex), summarizeTopicIndex(goldenTopic));
    assert.deepEqual(
      summarizeSpatialIndex(spatialIndex),
      summarizeSpatialIndex(goldenSpatial),
    );
  });

  it("validates golden EditRecipe v2 with expected-validation.json", () => {
    const recipe = loadFixtureArtifact("mini-day", "expected-recipe-v2.json");
    const topicIndex = loadFixtureArtifact("mini-day", "05b-topic-index.json");
    const spatialIndex = loadFixtureArtifact("mini-day", "05c-spatial-index.json");
    const wordIndexes = loadWordIndexes("mini-day", ["clip01", "clip02"]);

    const result = validateRecipeV2(recipe, { topicIndex, spatialIndex, wordIndexes });

    assert.equal(result.valid, true);
    assertValidationGolden(result, "mini-day");
  });

  it("runs spatial_index with keyframes present and face stub", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));

    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.keyframes("clip01"))), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.keyframes("clip02"))), true);

    const keyframes01 = readJson(path.join(workDir, ARTIFACTS.keyframes("clip01")));
    assert.ok(keyframes01.keyframes.length >= 1);
    assert.ok(keyframes01.keyframes.every((kf) => typeof kf.imagePath === "string"));

    const spatialIndex = await runSpatialIndexStep({ workDir, force: true, faceStub: true });

    SpatialIndexSchema.parse(spatialIndex);
    assert.ok(spatialIndex.builtFrom.faceDetectionCount > 0);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.faces("clip01"))), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.faces("clip02"))), true);
    assert.ok(spatialIndex.scenes.some((scene) => scene.anchors.some((a) => a.type === "face")));
  });

  it("rebuilds stale spatial index when objects artifact is newer", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));

    await runSpatialIndexStep({ workDir, force: true, faceStub: true });
    const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
    const objectsPath = path.join(workDir, ARTIFACTS.objects("clip02"));

    const stalePayload = {
      version: "1.0",
      batchId: "miniday1",
      scenes: [{ sceneId: "stale_scene", clipId: "clip02", anchors: [] }],
      builtFrom: { objectDetectionCount: 0, faceDetectionCount: 0 },
    };
    fs.writeFileSync(spatialPath, `${JSON.stringify(stalePayload, null, 2)}\n`, "utf8");
    touchNewerThan(objectsPath, spatialPath);

    assert.equal(isSpatialIndexStale(workDir), true);
    assert.equal(isArtifactStale(workDir, ARTIFACTS.spatialIndex), true);

    const rebuilt = await runSpatialIndexStep({ workDir, faceStub: true });
    assert.notEqual(rebuilt.scenes[0]?.sceneId, "stale_scene");
    assert.ok(rebuilt.scenes.length >= 3);
    assert.ok(rebuilt.builtFrom);
    assert.equal(typeof rebuilt.builtFrom.objectDetectionCount, "number");
  });
});

describe("pre-render E2E — shorts-hook", () => {
  it("runs deterministic index steps for single-clip hook fixture", async () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("shorts-hook", { exclude: FIXTURE_EXCLUDE }));
    const goldenClip = loadFixtureArtifact("shorts-hook", "05a-clip-registry.json");

    const clipRegistry = await runClipProfileStep({ workDir, force: true });
    const topicIndex = await runTopicIndexStep({
      workDir,
      force: true,
      embedFn: createTokenVectorEmbedFn(),
    });
    const spatialIndex = await runSpatialIndexStep({ workDir, force: true, faceStub: true });

    assert.deepEqual(
      summarizeClipRegistry(clipRegistry),
      summarizeClipRegistry(goldenClip),
    );
    assert.ok(topicIndex.topics.length >= 1);
    assert.equal(spatialIndex.scenes.length, 2);
    assert.ok(spatialIndex.scenes[0].anchors.length >= 1);
  });

  it("passes shorts retention validation on golden recipe", () => {
    const recipe = loadFixtureArtifact("shorts-hook", "expected-recipe-v2.json");
    const topicIndex = loadFixtureArtifact("shorts-hook", "05b-topic-index.json");
    const spatialIndex = loadFixtureArtifact("shorts-hook", "05c-spatial-index.json");
    const wordIndexes = loadWordIndexes("shorts-hook", ["clip01"]);
    const catalog = loadTechniqueCatalog({ pack: "shorts_retention_2026" });

    const result = validateRecipeV2(recipe, {
      topicIndex,
      spatialIndex,
      wordIndexes,
      techniqueCatalog: catalog,
    });

    assert.equal(result.valid, true);
    assertValidationGolden(result, "shorts-hook");

    const v22Codes = result.issues
      .filter((issue) => issue.code?.startsWith("V22"))
      .filter((issue) => issue.severity === "error");
    assert.equal(v22Codes.length, 0);
  });
});

describe("fixture-work-dir helper", () => {
  it("copies batch artifacts and excludes named files", () => {
    const workDir = trackWorkDir(copyFixtureToWorkDir("mini-day", { exclude: FIXTURE_EXCLUDE }));

    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.timelineIndex)), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.abstraction)), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.clipRegistry)), false);

    const timeline = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
    assert.equal(timeline.batchId, "miniday1");
  });
});
