import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateSceneRegistry,
  validateMinOutputs,
  validateEditRecipe,
} from "../validators/scene-registry.js";

const baseRecipe = {
  version: "1.0",
  batchId: "test01",
  batchContext: { qualityOverQuantity: true },
  outputs: [
    {
      outputId: "h1",
      format: "16:9",
      title: "Horizontal",
      timeline: [
        {
          segmentId: "s1",
          sourceRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
        },
      ],
    },
    {
      outputId: "v1",
      format: "9:16",
      title: "Vertical",
      timeline: [
        {
          segmentId: "s2",
          sourceRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 0,
          videoOutSec: 8,
        },
      ],
    },
  ],
  excluded: [],
  sceneUsageRegistry: [],
};

describe("scene registry validator", () => {
  it("accepts valid recipe with both formats", () => {
    const result = validateEditRecipe(baseRecipe);
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  it("rejects scene reuse within same format", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs.push({
      outputId: "h2",
      format: "16:9",
      title: "Horizontal 2",
      timeline: [
        {
          segmentId: "s3",
          sourceRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
        },
      ],
    });

    const issues = validateSceneRegistry(recipe);
    assert.ok(issues.some((i) => i.code === "SCENE_REUSE_WITHIN_FORMAT"));
    assert.equal(validateEditRecipe(recipe).valid, false);
  });

  it("allows scene reuse across formats", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[1].timeline[0].sourceRef.sceneId = "clip01_scene001";

    const issues = validateSceneRegistry(recipe);
    assert.equal(issues.length, 0);
  });

  it("requires minimum output formats", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs = [recipe.outputs[0]];
    const issues = validateMinOutputs(recipe, ["16:9", "9:16"]);
    assert.ok(issues.some((i) => i.code === "MISSING_OUTPUT_FORMAT"));
  });

  it("rejects invalid segment time range", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoInSec = 10;
    recipe.outputs[0].timeline[0].videoOutSec = 5;

    const issues = validateEditRecipe(recipe).issues;
    assert.ok(issues.some((i) => i.code === "INVALID_SEGMENT_RANGE"));
  });
});
