import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  diagnoseBatch,
  formatBatchDoctorReport,
  runBatchDoctor,
} from "./batch-doctor.js";
import { copyFixtureToWorkDir } from "../test-helpers/fixture-work-dir.js";
import { ARTIFACTS, readJson, writeJson } from "../pipeline/work-paths.js";

describe("batch_doctor", () => {
  it("reports critical issue when work dir is missing", () => {
    const diagnosis = diagnoseBatch("/tmp/does-not-exist-batch-doctor");
    assert.equal(diagnosis.ok, false);
    assert.equal(diagnosis.criticalCount, 1);
    assert.equal(diagnosis.issues[0].code, "WORK_DIR_MISSING");
  });

  it("diagnoses mini-day fixture through abstract step", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor" });
    const diagnosis = diagnoseBatch(workDir);

    assert.equal(diagnosis.manifestPresent, true);
    assert.equal(diagnosis.batchId, "miniday1");
    assert.ok(diagnosis.lastCompletedStep);
    assert.ok(["abstract", "spatial_index", "topic_index", "clip_profile", "index"].includes(diagnosis.lastCompletedStep));
    assert.equal(diagnosis.recipe.draftExists, false);
    assert.equal(diagnosis.recipe.finalExists, false);

    const report = formatBatchDoctorReport(diagnosis);
    assert.match(report, /Batch doctor: miniday1/);
    assert.match(report, /Work dir:/);
  });

  it("flags needsHumanReview on final recipe", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-review" });
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), {
      version: "2.2",
      batchId: "miniday1",
      outputs: [],
      creativeMoments: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), {
      version: "2.2",
      batchId: "miniday1",
      outputs: [],
      creativeMoments: [],
      needsHumanReview: true,
      reviewNotes: "Brak hooka w shortach",
    });
    writeJson(path.join(workDir, ARTIFACTS.review), {
      approved: false,
      summary: "Brak hooka w shortach",
      issues: [],
    });

    const diagnosis = diagnoseBatch(workDir);
    assert.equal(diagnosis.recipe.needsHumanReview, true);
    assert.ok(diagnosis.issues.some((issue) => issue.code === "NEEDS_HUMAN_REVIEW"));
  });

  it("runBatchDoctor exits with code 1 on critical issues", () => {
    const result = runBatchDoctor({ workDir: "/tmp/missing-batch-doctor-workdir" });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /WORK_DIR_MISSING/);
  });

  it("includes gpt usage summary when artifact present", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-gpt" });
    writeJson(path.join(workDir, ARTIFACTS.gptUsage), {
      version: "1.0",
      records: [
        {
          step: "direct",
          model: "gpt-5.5-mini",
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
        },
      ],
    });

    const diagnosis = diagnoseBatch(workDir);
    assert.equal(diagnosis.gptUsage.totals.calls, 1);
    assert.match(formatBatchDoctorReport(diagnosis), /GPT usage:/);
  });

  it("detects stale artifact when upstream is newer", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-stale" });
    const abstractionPath = path.join(workDir, ARTIFACTS.abstraction);
    const timelinePath = path.join(workDir, ARTIFACTS.timelineIndex);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(timelinePath, future, future);
    fs.utimesSync(abstractionPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const diagnosis = diagnoseBatch(workDir);
    assert.ok(diagnosis.staleArtifacts.some((entry) => entry.artifact === ARTIFACTS.abstraction));
    assert.ok(diagnosis.issues.some((issue) => issue.code === "STALE_ARTIFACT"));
  });

  it("warns on low briefSceneMapCoverage with many scenes", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-coverage" });
    const timeline = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
    timeline.scenes = Array.from({ length: 35 }, (_, i) => ({
      sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}`,
      clipId: "clip01",
    }));
    writeJson(path.join(workDir, ARTIFACTS.timelineIndex), timeline);
    writeJson(path.join(workDir, ARTIFACTS.recipeProvenance), {
      version: "1.0",
      batchId: timeline.batchId,
      directorMetrics: { briefSceneMapCoverage: 0.3 },
    });

    const diagnosis = diagnoseBatch(workDir);
    assert.ok(diagnosis.issues.some((issue) => issue.code === "DIRECTOR_SCENE_MAP_COVERAGE_LOW"));
  });

  it("warns when briefMetrics totals exceed threshold", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-brief-metrics" });
    writeJson(path.join(workDir, ARTIFACTS.recipeProvenance), {
      version: "1.0",
      batchId: "miniday1",
      directorMetrics: {
        briefMetrics: {
          calls: [{ task: "initial_draft", estimatedTokens: 250_000, jsonBytes: 1_000_000 }],
          totals: { callCount: 1, estimatedTokens: 250_000, jsonBytes: 1_000_000 },
        },
      },
    });

    const diagnosis = diagnoseBatch(workDir);
    assert.ok(diagnosis.issues.some((issue) => issue.code === "BRIEF_PAYLOAD_LARGE"));
    assert.ok(diagnosis.issues.some((issue) => issue.code === "BRIEF_PAYLOAD_TOTAL_LARGE"));
  });

  it("warns when super critic did not approve on super path", () => {
    const workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-doctor-super-critic" });
    const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
    abstraction.L2 = [{ segmentId: "seg1" }, { segmentId: "seg2" }];
    writeJson(path.join(workDir, ARTIFACTS.abstraction), abstraction);
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), {
      version: "2.2",
      batchId: "miniday1",
      outputs: [],
      creativeMoments: [],
    });
    writeJson(path.join(workDir, ARTIFACTS.recipeProvenance), {
      version: "1.0",
      batchId: "miniday1",
      superCriticReview: { approved: false, issues: [], summary: "callback missing" },
      stitchValidation: { valid: true, issues: [] },
    });

    const diagnosis = diagnoseBatch(workDir);
    assert.ok(diagnosis.issues.some((issue) => issue.code === "SUPER_CRITIC_NOT_APPROVED"));
  });
});
