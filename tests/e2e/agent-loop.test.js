import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  copyFixtureToWorkDir,
  cleanupWorkDir,
  loadFixtureArtifact,
} from "../../src/test-helpers/fixture-work-dir.js";
import {
  createMiniDayMockClient,
  buildMiniDayAgentLoopResponses,
  createMockOpenAIClient,
} from "../../src/test-helpers/mock-openai-client.js";
import { runClipProfileStep } from "../../src/pipeline/steps/clip-profile.js";
import { runTopicIndexStep, createTokenVectorEmbedFn } from "../../src/pipeline/steps/topic-index.js";
import { runSpatialIndexStep } from "../../src/pipeline/steps/spatial-index.js";
import {
  runAbstractStep,
  runDirectStep,
  runReviewStep,
} from "../../src/pipeline/steps/agents.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { ARTIFACTS, readJson } from "../../src/pipeline/work-paths.js";

const AGENT_LOOP_EXCLUDE = [
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

async function prepareMiniDayWorkDir(mockClient) {
  const workDir = trackWorkDir(
    copyFixtureToWorkDir("mini-day", { exclude: AGENT_LOOP_EXCLUDE, prefix: "vea-agent-loop" }),
  );

  await runClipProfileStep({ workDir, force: true });
  await runAbstractStep({ workDir, openaiClient: mockClient, force: true });
  await runTopicIndexStep({
    workDir,
    force: true,
    embedFn: createTokenVectorEmbedFn(),
  });
  await runSpatialIndexStep({ workDir, force: true, faceStub: true });

  return workDir;
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

function assertValidRecipe(recipe, validationContext) {
  const parsed = EditRecipeV2Schema.parse(recipe);
  const validation = validateRecipeV2(parsed, {
    requiredFormats: ["16:9", "9:16"],
    ...validationContext,
  });

  const errors = validation.issues.filter((issue) => issue.severity === "error");
  assert.equal(errors.length, 0, `validation errors: ${errors.map((e) => e.code).join(", ")}`);
  assert.equal(validation.valid, true);

  assert.ok(parsed.outputs.length >= 1, "recipe must have outputs");
  assert.ok(
    parsed.outputs.every((output) => Array.isArray(output.timeline) && output.timeline.length > 0),
    "each output must have timeline segments",
  );
  assert.ok(
    Number.parseFloat(parsed.version) >= 2.0,
    `recipe version must be 2.0+, got ${parsed.version}`,
  );

  return { parsed, validation };
}

describe("agent-loop E2E — mini-day abstract → direct → review", () => {
  it("produces valid EditRecipe v2 when critic approves (mocked OpenAI)", async () => {
    const mockClient = createMiniDayMockClient({ criticApproves: true });
    const workDir = await prepareMiniDayWorkDir(mockClient);
    const validationContext = loadValidationContext(workDir);

    const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));

    assert.equal(abstraction.batchId, "miniday1");
    assert.equal(abstraction.L1.length, 3);
    assert.ok(abstraction.L1.some((entry) => entry.sceneId === "clip01_scene001"));
    assert.ok(abstraction.L1.some((entry) => entry.topics?.includes("restauracja")));
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.abstraction)), true);

    const draft = await runDirectStep({
      workDir,
      openaiClient: mockClient,
      force: true,
    });

    assert.equal(draft.batchId, "miniday1");
    assert.ok(draft.outputs.length >= 2);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeDraft)), true);

    const reviewResult = await runReviewStep({
      workDir,
      openaiClient: mockClient,
      force: true,
      maxIterations: 1,
    });

    assert.equal(reviewResult.finalWritten, true);
    assert.equal(reviewResult.review.approved, true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeFinal)), true);

    const finalRecipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const { parsed, validation } = assertValidRecipe(finalRecipe, validationContext);

    assert.equal(reviewResult.validation.valid, true);
    assert.equal(parsed.outputs.some((o) => o.format === "16:9"), true);
    assert.equal(parsed.outputs.some((o) => o.format === "9:16"), true);
    assert.ok(
      parsed.outputs.some((o) =>
        o.timeline.some((seg) => seg.videoRef?.sceneId === "clip02_scene001"),
      ),
      "B-roll scene clip02_scene001 should appear in timeline",
    );
    assert.equal(validation.issues.filter((i) => i.severity === "error").length, 0);
  });

  it("fixes invalid draft via fixer and writes valid final recipe (mocked OpenAI)", async () => {
    const mockClient = createMockOpenAIClient(
      buildMiniDayAgentLoopResponses({ criticApproves: false }),
    );
    const workDir = await prepareMiniDayWorkDir(mockClient);
    const validationContext = loadValidationContext(workDir);

    await runDirectStep({ workDir, openaiClient: mockClient, force: true });

    const reviewResult = await runReviewStep({
      workDir,
      openaiClient: mockClient,
      force: true,
      maxIterations: 1,
    });

    assert.equal(reviewResult.finalWritten, true);
    assert.equal(reviewResult.review.approved, false);

    const finalRecipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const { parsed } = assertValidRecipe(finalRecipe, validationContext);

    assert.equal(parsed.outputs.some((o) => o.format === "9:16"), true);
    assert.equal(reviewResult.validation.valid, true);
  });

  it("uses vision caption fixtures for richer L1 context", () => {
    const visionClip01 = loadFixtureArtifact("mini-day", "03-vision-clip01.json");
    const visionClip02 = loadFixtureArtifact("mini-day", "03-vision-clip02.json");

    assert.equal(visionClip01.clipId, "clip01");
    assert.ok(visionClip01.captions.some((c) => c.tags?.includes("restauracja")));
    assert.equal(visionClip02.clipId, "clip02");
    assert.ok(visionClip02.captions.length >= 2);
  });
});
