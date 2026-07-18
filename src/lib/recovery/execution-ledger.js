import { randomUUID } from "node:crypto";
import path from "node:path";
import { ARTIFACTS, writeJson } from "../../pipeline/work-paths.js";
import { ExecutionStateSchema } from "../../schemas/execution-state.js";
import { classifyError } from "./classify-error.js";

export class ExecutionLedger {
  constructor(workDir, batchId) {
    this.workDir = workDir;
    this.batchId = batchId;
    this.pipelineRunId = randomUUID();
    this.state = ExecutionStateSchema.parse({
      version: "1.0",
      pipelineRunId: this.pipelineRunId,
      batchId,
      status: "running",
      startedAt: new Date().toISOString(),
      currentStep: null,
      steps: {},
    });
  }

  persist() {
    writeJson(path.join(this.workDir, ARTIFACTS.executionState), this.state);
    return this.state;
  }

  beginRun() {
    this.state.status = "running";
    this.state.startedAt = new Date().toISOString();
    this.state.finishedAt = undefined;
    return this.persist();
  }

  beginStep(step) {
    this.state.currentStep = step;
    this.state.steps[step] = {
      status: "running",
      startedAt: new Date().toISOString(),
      clipOutcomes: this.state.steps[step]?.clipOutcomes ?? {},
    };
    return this.persist();
  }

  finishStep(step, status = "succeeded") {
    const existing = this.state.steps[step] ?? {};
    this.state.steps[step] = {
      ...existing,
      status,
      finishedAt: new Date().toISOString(),
    };
    if (this.state.currentStep === step) {
      this.state.currentStep = null;
    }
    return this.persist();
  }

  recordClipOutcome(step, clipId, status, error = null) {
    const stepState = this.state.steps[step] ?? {
      status: "running",
      startedAt: new Date().toISOString(),
      clipOutcomes: {},
    };
    const classified = error ? classifyError(error, { step, batchId: this.batchId }) : null;
    stepState.clipOutcomes = stepState.clipOutcomes ?? {};
    stepState.clipOutcomes[clipId] = {
      status,
      ...(classified?.code ? { errorCode: classified.code } : {}),
      ...(classified?.message ? { message: classified.message } : {}),
    };
    this.state.steps[step] = stepState;
    return this.persist();
  }

  failStep(step, error) {
    const classified = classifyError(error, { step, batchId: this.batchId });
    const existing = this.state.steps[step] ?? {};
    this.state.steps[step] = {
      ...existing,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: {
        code: classified.code,
        message: classified.message,
        ...(classified.cause ? { cause: classified.cause } : {}),
      },
    };
    this.state.currentStep = step;
    this.state.status = "failed";
    this.state.finishedAt = new Date().toISOString();
    return this.persist();
  }

  finishRun(status = "succeeded") {
    this.state.status = status;
    this.state.finishedAt = new Date().toISOString();
    this.state.currentStep = null;
    return this.persist();
  }

  getState() {
    return this.state;
  }
}
