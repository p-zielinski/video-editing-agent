import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTIFACTS, writeJson } from "./work-paths.js";
import { ERROR_CODES } from "../lib/recovery/error-codes.js";
import { StepFailureError } from "../lib/recovery/errors.js";
import { persistPipelineFailure } from "../lib/recovery/orchestrator-hooks.js";
import { ExecutionLedger } from "../lib/recovery/execution-ledger.js";
import { readRecoveryPlan } from "../lib/recovery/plan-writer.js";

describe("orchestrator recovery", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-orch-recovery-"));
    writeJson(path.join(workDir, ARTIFACTS.manifest), { batchId: "test01" });
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("persistPipelineFailure writes recovery plan artifact", () => {
    const ledger = new ExecutionLedger(workDir, "test01");
    ledger.beginRun();
    ledger.beginStep("audio_enhancement");
    const error = new StepFailureError("failed", {
      code: ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED,
      step: "audio_enhancement",
      failures: [{
        clipId: "clip01",
        code: ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED,
        message: "missing binary",
        scope: { clipId: "clip01" },
      }],
    });
    ledger.failStep("audio_enhancement", error);
    const plan = persistPipelineFailure({
      error,
      batchId: "test01",
      workDir,
      ledger,
      step: "audio_enhancement",
    });
    const loaded = readRecoveryPlan(workDir);
    assert.equal(plan.recommendedCommand, loaded.recommendedCommand);
    assert.equal(loaded.failures[0].scope?.clipId, "clip01");
  });
});
