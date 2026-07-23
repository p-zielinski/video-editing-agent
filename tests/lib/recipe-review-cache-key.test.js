import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecipeReviewCacheKey } from "../../src/lib/recipe-review-cache-key.js";

describe("buildRecipeReviewCacheKey", () => {
  const baseRecipe = {
    outputs: [
      { outputId: "main_16x9", timeline: [{ segmentId: "a" }, { segmentId: "b" }] },
      { outputId: "short_9x16", timeline: [{ segmentId: "s1" }] },
    ],
    creativeMoments: [{ momentId: "cm_1" }, { momentId: "cm_2" }],
    creativityProfile: { level: "balanced" },
  };

  it("returns stable hash for same recipe shape", () => {
    const a = buildRecipeReviewCacheKey(baseRecipe);
    const b = buildRecipeReviewCacheKey(structuredClone(baseRecipe));
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{12}$/);
  });

  it("changes when output ids or segment counts change", () => {
    const base = buildRecipeReviewCacheKey(baseRecipe);
    const renamed = buildRecipeReviewCacheKey({
      ...baseRecipe,
      outputs: [
        { outputId: "output_0_16x9", timeline: baseRecipe.outputs[0].timeline },
        baseRecipe.outputs[1],
      ],
    });
    const moreMoments = buildRecipeReviewCacheKey({
      ...baseRecipe,
      creativeMoments: [...baseRecipe.creativeMoments, { momentId: "cm_3" }],
    });

    assert.notEqual(base, renamed);
    assert.notEqual(base, moreMoments);
  });
});
