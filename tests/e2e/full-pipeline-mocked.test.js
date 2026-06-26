import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
  resolveFixtureBatch,
} from "../../src/test-helpers/fixture-work-dir.js";
import { createMiniDayMockClient } from "../../src/test-helpers/mock-openai-client.js";
import { runClipProfileStep } from "../../src/pipeline/steps/clip-profile.js";
import { runTopicIndexStep } from "../../src/pipeline/steps/topic-index.js";
import { runSpatialIndexStep } from "../../src/pipeline/steps/spatial-index.js";
import {
  runAbstractStep,
  runDirectStep,
  runReviewStep,
} from "../../src/pipeline/steps/agents.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const FULL_PIPELINE_EXCLUDE = [
  "05a-clip-registry.json",
  "05b-topic-index.json",
  "05c-spatial-index.json",
  "06-abstract.json",
  "expected-recipe-v2.json",
  "expected-validation.json",
  "golden-recipe-v2.json",
  "README.md",
  "spatial-index.json",
  "topic-index.json",
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

function listFixtureKeyframes(batchName) {
  const batchDir = resolveFixtureBatch(batchName);
  return fs
    .readdirSync(batchDir)
    .filter((name) => name.startsWith("02-keyframes-") && name.endsWith(".json"));
}

function assertKeyframesCopied(workDir, batchName) {
  for (const fileName of listFixtureKeyframes(batchName)) {
    const dest = path.join(workDir, fileName);
    assert.equal(
      fs.existsSync(dest),
      true,
      `expected keyframes artifact ${fileName} to be copied into work dir`,
    );
  }
}

function loadValidationContext(workDir) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  return {
    topicIndex: readJson(path.join(workDir, ARTIFACTS.topicIndex)),
    spatialIndex: readJson(path.join(workDir, ARTIFACTS.spatialIndex)),
    wordIndexes: catalog.clips.map((clip) =>
      readJson(path.join(workDir, ARTIFACTS.words(clip.clipId))),
    ),
  };
}

async function runMockedFullPipeline(mockClient) {
  const workDir = trackWorkDir(
    copyFixtureToWorkDir("mini-day", { exclude: FULL_PIPELINE_EXCLUDE, prefix: "vea-full-pipeline" }),
  );

  assertKeyframesCopied(workDir, "mini-day");

  await runClipProfileStep({ workDir, force: true });
  await runAbstractStep({ workDir, openaiClient: mockClient, force: true });
  const topicIndex = await runTopicIndexStep({ workDir, force: true, stub: true });
  await runSpatialIndexStep({ workDir, force: true, faceStub: true });

  const draft = await runDirectStep({
    workDir,
    openaiClient: mockClient,
    force: true,
    faceStub: true,
  });

  const reviewResult = await runReviewStep({
    workDir,
    openaiClient: mockClient,
    force: true,
    faceStub: true,
    maxIterations: 1,
  });

  return { workDir, topicIndex, draft, reviewResult };
}

describe("full-pipeline E2E — mini-day (mocked OpenAI, no ffmpeg)", () => {
  it("runs clip_profile → abstract → topic_index → spatial_index → direct → review", async () => {
    const mockClient = createMiniDayMockClient({ criticApproves: true });
    const { workDir, topicIndex, draft, reviewResult } = await runMockedFullPipeline(mockClient);
    const validationContext = loadValidationContext(workDir);

    assert.equal(topicIndex.version, "1.0", "topic index should run without embeddings");
    assert.ok(topicIndex.topics.length >= 1);

    const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
    assert.equal(abstraction.batchId, "miniday1");
    assert.equal(abstraction.L1.length, 3);

    assert.equal(draft.batchId, "miniday1");
    assert.ok(draft.outputs.length >= 2);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeDraft)), true);

    assert.equal(reviewResult.finalWritten, true);
    assert.equal(reviewResult.review.approved, true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeFinal)), true);

    const finalRecipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const parsed = EditRecipeV2Schema.parse(finalRecipe);
    const validation = validateRecipeV2(parsed, {
      requiredFormats: ["16:9", "9:16"],
      ...validationContext,
    });

    const errors = validation.issues.filter((issue) => issue.severity === "error");
    assert.equal(errors.length, 0, `validation errors: ${errors.map((e) => e.code).join(", ")}`);
    assert.equal(validation.valid, true);
    assert.equal(reviewResult.validation.valid, true);

    assert.ok(parsed.outputs.some((o) => o.format === "16:9"));
    assert.ok(parsed.outputs.some((o) => o.format === "9:16"));
    assert.ok(
      parsed.outputs.some((o) =>
        o.timeline.some((seg) => seg.videoRef?.sceneId === "clip02_scene001"),
      ),
      "B-roll scene clip02_scene001 should appear in final recipe",
    );
  });
});
