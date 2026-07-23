import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTIFACTS } from "../../pipeline/work-paths.js";
import { ERROR_CODES } from "./error-codes.js";
import { StepFailureError, AnalysisWaveFailure } from "./errors.js";
import {
  buildRecoveryPlan,
  clearRecoveryPlan,
  readRecoveryPlan,
  writeRecoveryPlan,
} from "./plan-writer.js";
import { ExecutionLedger } from "./execution-ledger.js";

describe("recovery plan-writer", () => {
  let workDir;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-recovery-"));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("writes and reads recovery plan", () => {
    const ledger = new ExecutionLedger(workDir, "batch01");
    ledger.beginRun();
    const error = new StepFailureError("audio_enhancement failed", {
      code: ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED,
      step: "audio_enhancement",
      failures: [{
        clipId: "clip16",
        code: ERROR_CODES.AUDIO_ENH_DEEPFILTERNET_FAILED,
        message: "deepFilter missing",
        scope: { clipId: "clip16" },
      }],
    });
    const plan = buildRecoveryPlan({
      error,
      batchId: "batch01",
      workDir,
      ledger,
      step: "audio_enhancement",
    });
    writeRecoveryPlan(workDir, plan);
    const loaded = readRecoveryPlan(workDir);
    assert.equal(loaded.status, "action_required");
    assert.equal(loaded.failedStep, "audio_enhancement");
    assert.match(loaded.recommendedCommand, /--from-step audio_enhancement/);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.recoveryPlan)), true);
  });

  it("clearRecoveryPlan removes artifact", () => {
    clearRecoveryPlan(workDir);
    assert.equal(readRecoveryPlan(workDir), null);
  });

  it("prefers error.step over orchestrator step for failedStep", () => {
    const error = new AnalysisWaveFailure("vision: 1 klip(ów) nie powiodło się (clip16)", {
      step: "vision",
      failures: [{
        clipId: "clip16",
        code: ERROR_CODES.VISION_CLIP_FAILED,
        message: "Python timeout",
        scope: { clipId: "clip16" },
      }],
    });
    const plan = buildRecoveryPlan({
      error,
      batchId: "batch01",
      workDir,
      step: "transcribe",
    });
    assert.equal(plan.failedStep, "vision");
    assert.equal(plan.failures[0].step, "vision");
  });
});
