import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA } from "../../src/schemas/export-director-schema.js";

describe("export-director-schema ai hook contract", () => {
  it("includes ai_hook segment role and aiHookDecision on outputs", () => {
    const timelineExample = EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA.outputs[0].timeline[0];
    assert.match(timelineExample.segmentRole, /ai_hook/);

    const outputShape = EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA.outputs[0];
    assert.equal(outputShape.aiHookDecision.action, "accept|reject");
    assert.ok(outputShape.aiHookDecision.clipId);
    assert.ok(outputShape.aiHookDecision.reason);
  });
});
