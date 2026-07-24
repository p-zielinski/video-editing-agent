import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PIPELINE_STEPS, validatePipelineStep } from "./work-paths.js";

describe("work-paths", () => {
  it("validatePipelineStep accepts known steps", () => {
    for (const step of PIPELINE_STEPS) {
      assert.equal(validatePipelineStep(step, "--from-step"), null);
    }
  });

  it("validatePipelineStep rejects typos with helpful message", () => {
    const error = validatePipelineStep("spacial_index", "--from-step");
    assert.ok(error?.includes("--from-step"));
    assert.ok(error?.includes("spatial_index"));
  });

  it("runs audio_enhancement immediately after ingest and before transcribe", () => {
    const ingestIdx = PIPELINE_STEPS.indexOf("ingest");
    const enhIdx = PIPELINE_STEPS.indexOf("audio_enhancement");
    const transcribeIdx = PIPELINE_STEPS.indexOf("transcribe");
    const directIdx = PIPELINE_STEPS.indexOf("direct");

    assert.equal(enhIdx, ingestIdx + 1);
    assert.ok(enhIdx < transcribeIdx);
    assert.ok(enhIdx < directIdx);
    assert.equal(PIPELINE_STEPS.filter((step) => step === "audio_enhancement").length, 1);
  });
});
