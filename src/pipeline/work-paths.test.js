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
});
