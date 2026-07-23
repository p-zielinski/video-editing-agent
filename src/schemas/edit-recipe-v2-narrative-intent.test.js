import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CreativeMomentSchema } from "./edit-recipe-v2.js";

const baseMoment = {
  momentId: "m1",
  techniqueId: "color_desaturate",
  outputId: "output_0_16x9",
  outputStartSec: 0,
  outputEndSec: 1,
  reason: "test",
};

describe("NarrativeIntentSchema", () => {
  it("coerces callback to reveal", () => {
    const parsed = CreativeMomentSchema.parse({
      ...baseMoment,
      narrativeIntent: "callback",
    });
    assert.equal(parsed.narrativeIntent, "reveal");
  });

  it("coerces flashback to memory", () => {
    const parsed = CreativeMomentSchema.parse({
      ...baseMoment,
      narrativeIntent: "flashback",
    });
    assert.equal(parsed.narrativeIntent, "memory");
  });

  it("strips unknown narrativeIntent values", () => {
    const parsed = CreativeMomentSchema.parse({
      ...baseMoment,
      narrativeIntent: "foobar",
    });
    assert.equal(parsed.narrativeIntent, undefined);
  });

  it("preserves valid narrativeIntent values", () => {
    const parsed = CreativeMomentSchema.parse({
      ...baseMoment,
      narrativeIntent: "tension",
    });
    assert.equal(parsed.narrativeIntent, "tension");
  });
});
