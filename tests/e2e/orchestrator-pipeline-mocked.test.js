import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipeline } from "../../src/pipeline/orchestrator.js";
import { resolveFfmpegBins } from "../../src/lib/ffmpeg-bin.js";
import { createMiniDayMockClient } from "../../src/test-helpers/mock-openai-client.js";
import {
  cleanupWorkDir,
  resolveFixtureBatch,
  seedBatchWorkDirFromFixture,
} from "../../src/test-helpers/fixture-work-dir.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { ARTIFACTS, readJson, resolveWorkDir } from "../../src/pipeline/work-paths.js";

const AGENT_PIPELINE_EXCLUDE = [
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

function isFfmpegAvailable() {
  const { ffmpeg } = resolveFfmpegBins();
  const result = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  return result.status === 0;
}

function createTinyInboxMp4s() {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-orch-inbox-"));
  trackWorkDir(inboxDir);
  const { ffmpeg } = resolveFfmpegBins();

  for (let i = 1; i <= 2; i += 1) {
    const outPath = path.join(inboxDir, `clip0${i}.mp4`);
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        outPath,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed to create ${outPath}: ${result.stderr}`);
    }
  }

  return inboxDir;
}

describe("orchestrator runPipeline E2E — mini-day (mocked OpenAI)", () => {
  it("runPipeline abstract → review wires clip_profile through review", async () => {
    const batchId = `orch-abs-${Date.now().toString(36)}`;
    const workDir = trackWorkDir(
      seedBatchWorkDirFromFixture("mini-day", batchId, { exclude: AGENT_PIPELINE_EXCLUDE }),
    );

    assertKeyframesCopied(workDir, "mini-day");

    const mockClient = createMiniDayMockClient({ criticApproves: true });
    const result = await runPipeline({
      batchId,
      fromStep: "abstract",
      toStep: "review",
      openaiClient: mockClient,
      faceStub: true,
      force: true,
      userContext: "vlog dzień 66/100 — restauracja i spacer",
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(result.batchId, batchId);
    assert.equal(result.validationFailed, false);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recipeFinal)), true);

    const topicIndex = readJson(path.join(workDir, ARTIFACTS.topicIndex));
    assert.equal(topicIndex.version, "1.0", "topic index should run without embeddings");
    assert.ok(topicIndex.topics.length >= 1);

    const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
    assert.equal(abstraction.batchId, "miniday1");
    assert.equal(abstraction.L1.length, 3);

    const draft = readJson(path.join(workDir, ARTIFACTS.recipeDraft));
    assert.equal(draft.batchId, "miniday1");
    assert.ok(draft.outputs.length >= 2);

    assert.equal(result.review.finalWritten, true);
    assert.equal(result.review.review.approved, true);

    const finalRecipe = readJson(path.join(workDir, ARTIFACTS.recipeFinal));
    const parsed = EditRecipeV2Schema.parse(finalRecipe);
    const validationContext = loadValidationContext(workDir);
    const validation = validateRecipeV2(parsed, {
      requiredFormats: ["16:9", "9:16"],
      ...validationContext,
    });

    const errors = validation.issues.filter((issue) => issue.severity === "error");
    assert.equal(errors.length, 0, `validation errors: ${errors.map((e) => e.code).join(", ")}`);
    assert.equal(validation.valid, true);
    assert.equal(result.review.validation.valid, true);

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

describe("orchestrator runPipeline E2E — ingest → index (optional, live APIs)", () => {
  it("runPipeline ingest → index with --fast stubs when ffmpeg and OPENAI_API_KEY are set", async (t) => {
    if (!isFfmpegAvailable()) {
      return t.skip("ffmpeg not available");
    }
    if (!process.env.OPENAI_API_KEY) {
      return t.skip("OPENAI_API_KEY not set — transcribe requires live Whisper API");
    }

    const batchId = `orch-ing-${Date.now().toString(36)}`;
    const workDir = resolveWorkDir(batchId);
    trackWorkDir(workDir);

    const inboxDir = createTinyInboxMp4s();

    const result = await runPipeline({
      batchId,
      inputDir: inboxDir,
      fromStep: "ingest",
      toStep: "index",
      apiKey: process.env.OPENAI_API_KEY,
      visionStub: true,
      faceStub: true,
      audioStub: true,
      objectsStub: true,
      sceneDetectStub: true,
      force: true,
    });

    assert.equal(result.batchId, batchId);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.manifest)), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.sceneCatalog)), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.timelineIndex)), true);

    const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
    assert.equal(catalog.clips.length, 2);

    for (const clip of catalog.clips) {
      assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.words(clip.clipId))), true);
      assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.keyframes(clip.clipId))), true);
      assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.vision(clip.clipId))), true);
    }
  });
});
