import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAnalysisPhase } from "./analysis-phase.js";
import { writeJson, ARTIFACTS } from "./work-paths.js";

function createTrackingLedger() {
  const events = [];
  return {
    events,
    beginStep(step) {
      events.push({ type: "begin", step });
    },
    finishStep(step) {
      events.push({ type: "finish", step });
    },
    failStep() {},
    recordClipOutcome() {},
  };
}

function createVisionObjectsWorkDir() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-analysis-phase-"));
  const clipId = "clip01";
  writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), {
    batchId: "batch-test",
    clips: [{ clipId, fileName: "clip01.mp4", durationSec: 10 }],
    scenes: [],
  });
  writeJson(path.join(workDir, ARTIFACTS.manifest), {
    batchId: "batch-test",
    clips: [{ clipId, fileName: "clip01.mp4", durationSec: 10 }],
  });
  writeJson(path.join(workDir, ARTIFACTS.keyframes(clipId)), {
    version: "1.0",
    clipId,
    keyframes: [],
  });
  return workDir;
}

describe("analysis-phase", () => {
  let previousParallelClips;
  let previousParallelGpu;

  beforeEach(() => {
    previousParallelClips = process.env.ANALYSIS_PARALLEL_CLIPS;
    previousParallelGpu = process.env.ANALYSIS_PARALLEL_GPU_STEPS;
    delete process.env.ANALYSIS_PARALLEL_CLIPS;
    delete process.env.ANALYSIS_PARALLEL_GPU_STEPS;
  });

  afterEach(() => {
    if (previousParallelClips === undefined) {
      delete process.env.ANALYSIS_PARALLEL_CLIPS;
    } else {
      process.env.ANALYSIS_PARALLEL_CLIPS = previousParallelClips;
    }
    if (previousParallelGpu === undefined) {
      delete process.env.ANALYSIS_PARALLEL_GPU_STEPS;
    } else {
      process.env.ANALYSIS_PARALLEL_GPU_STEPS = previousParallelGpu;
    }
  });

  it("runs vision before objects in default sequential mode", async () => {
    const workDir = createVisionObjectsWorkDir();
    const ledger = createTrackingLedger();

    try {
      await runAnalysisPhase({
        workDir,
        fromStep: "vision",
        toStep: "objects",
        twelvelabsEnabled: false,
        visionStub: true,
        objectsStub: true,
        ledger,
      });

      const visionBegin = ledger.events.findIndex((event) => event.type === "begin" && event.step === "vision");
      const visionFinish = ledger.events.findIndex((event) => event.type === "finish" && event.step === "vision");
      const objectsBegin = ledger.events.findIndex((event) => event.type === "begin" && event.step === "objects");
      const objectsFinish = ledger.events.findIndex((event) => event.type === "finish" && event.step === "objects");

      assert.ok(visionBegin >= 0, "vision should begin");
      assert.ok(objectsBegin >= 0, "objects should begin");
      assert.ok(visionFinish >= 0, "vision should finish");
      assert.ok(objectsFinish >= 0, "objects should finish");
      assert.ok(visionBegin < objectsBegin, "vision must start before objects");
      assert.ok(visionFinish < objectsBegin, "vision must finish before objects starts");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("does not overlap vision and objects ledger steps in default mode", async () => {
    const workDir = createVisionObjectsWorkDir();
    const ledger = createTrackingLedger();

    try {
      await runAnalysisPhase({
        workDir,
        fromStep: "vision",
        toStep: "objects",
        twelvelabsEnabled: false,
        visionStub: true,
        objectsStub: true,
        ledger,
      });

      const openSteps = new Set();
      for (const event of ledger.events) {
        if (event.type === "begin") {
          if (event.step === "vision" || event.step === "objects") {
            const other = event.step === "vision" ? "objects" : "vision";
            assert.equal(
              openSteps.has(other),
              false,
              `${event.step} began while ${other} was still running`,
            );
          }
          openSteps.add(event.step);
        } else if (event.type === "finish") {
          openSteps.delete(event.step);
        }
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("runs vision and objects in parallel when ANALYSIS_PARALLEL_GPU_STEPS=1", async () => {
    process.env.ANALYSIS_PARALLEL_GPU_STEPS = "1";
    const workDir = createVisionObjectsWorkDir();
    const ledger = createTrackingLedger();

    try {
      await runAnalysisPhase({
        workDir,
        fromStep: "vision",
        toStep: "objects",
        twelvelabsEnabled: false,
        visionStub: true,
        objectsStub: true,
        ledger,
      });

      const visionBegin = ledger.events.findIndex((event) => event.type === "begin" && event.step === "vision");
      const objectsBegin = ledger.events.findIndex((event) => event.type === "begin" && event.step === "objects");
      const visionFinish = ledger.events.findIndex((event) => event.type === "finish" && event.step === "vision");
      const objectsFinish = ledger.events.findIndex((event) => event.type === "finish" && event.step === "objects");

      assert.ok(visionBegin >= 0 && objectsBegin >= 0);
      assert.ok(visionFinish >= 0 && objectsFinish >= 0);
      assert.ok(
        visionBegin < visionFinish && objectsBegin < objectsFinish,
        "both steps should run to completion",
      );
      assert.ok(
        visionBegin < objectsFinish && objectsBegin < visionFinish,
        "vision and objects should overlap in parallel GPU mode",
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
