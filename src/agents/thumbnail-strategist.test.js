import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStubThumbnailPlan } from "./thumbnail-strategist.js";

describe("thumbnail strategist brand safety", () => {
  it("sanitizes public thumbnail and metadata text", () => {
    const plan = buildStubThumbnailPlan({
      recipe: {
        batchId: "b1",
        batchContext: { brandSafety: { enabled: true } },
        outputs: [{
          outputId: "short",
          format: "9:16",
          title: "Morderca i kurwa",
        }],
      },
      frameShortlistByOutput: {
        short: [{
          clipId: "clip01",
          sceneId: "clip01_scene001",
          timestampSec: 1,
        }],
      },
    });

    const variant = plan.outputs[0].variants[0];
    assert.equal(variant.headline.includes("m******a"), true);
    assert.equal(variant.headline.includes("k***a"), true);
    assert.equal(variant.titleVariant.includes("Morderca"), false);
    assert.equal(variant.descriptionVariant.includes("Morderca"), false);
  });
});
