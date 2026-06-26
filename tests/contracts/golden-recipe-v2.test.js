import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { TopicIndexSchema } from "../../src/schemas/edit-recipe-v2.js";
import { SpatialIndexSchema } from "../../src/schemas/spatial-index.js";

const BATCH_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/batches/mini-day",
);

function loadBatchJson(name) {
  return JSON.parse(fs.readFileSync(path.join(BATCH_DIR, name), "utf8"));
}

describe("golden recipe v2.2 (mini-day batch)", () => {
  const recipe = loadBatchJson("golden-recipe-v2.json");
  const topicIndex = TopicIndexSchema.parse(loadBatchJson("topic-index.json"));
  const spatialIndex = SpatialIndexSchema.parse(loadBatchJson("spatial-index.json"));

  it("golden-recipe-v2.json parses as EditRecipeV2", () => {
    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.2");
    assert.ok(parsed.shortsRetentionProfile?.enabled);
  });

  it("passes validateRecipeV2 with batch topic and spatial indexes", () => {
    const result = validateRecipeV2(recipe, {
      topicIndex,
      spatialIndex,
      requiredFormats: recipe.batchContext.requiredFormats,
    });

    const errors = result.issues.filter((i) => i.severity === "error");
    assert.equal(
      result.valid,
      true,
      errors.map((e) => `${e.code}: ${e.message}`).join("\n"),
    );
  });

  it("includes retention hook and beats on short output", () => {
    const shortOutput = recipe.outputs.find((o) => o.outputKind === "short");
    assert.ok(shortOutput);
    const hooks = recipe.creativeMoments.filter((m) => m.retentionRole === "hook");
    const beats = recipe.creativeMoments.filter((m) => m.retentionRole === "beat");
    assert.ok(hooks.length >= 1);
    assert.ok(beats.length >= 2);
  });
});
