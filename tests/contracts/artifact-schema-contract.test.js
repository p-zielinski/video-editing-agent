import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AbstractionBundleSchema,
  AbstractL1Schema,
  AbstractL2Schema,
  AbstractL3Schema,
  ReviewResultSchema,
} from "../../src/schemas/edit-recipe.js";
import { EditRecipeV2Schema, TopicIndexSchema } from "../../src/schemas/edit-recipe-v2.js";
import { TimelineIndexSchema } from "../../src/schemas/timeline-index.js";
import { SpatialIndexSchema } from "../../src/schemas/spatial-index.js";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/agents/fixtures",
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

const ARTIFACT_FIXTURES = [
  { file: "timeline-index.json", schema: TimelineIndexSchema, label: "TimelineIndex" },
  { file: "abstraction.json", schema: AbstractionBundleSchema, label: "AbstractionBundle" },
  { file: "summarizer-l1.json", schema: AbstractL1Schema, label: "AbstractL1" },
  { file: "summarizer-l2.json", schema: AbstractL2Schema, label: "AbstractL2" },
  { file: "summarizer-l3.json", schema: AbstractL3Schema, label: "AbstractL3" },
  { file: "recipe-draft.json", schema: EditRecipeV2Schema, label: "EditRecipeV2 draft" },
  { file: "fixer-response.json", schema: EditRecipeV2Schema, label: "EditRecipeV2 fixer" },
];

describe("artifact-schema contract: agent fixtures vs Zod", () => {
  for (const { file, schema, label } of ARTIFACT_FIXTURES) {
    it(`${label} (${file}) validates against Zod schema`, () => {
      const data = loadFixture(file);
      const result = schema.safeParse(data);
      assert.equal(
        result.success,
        true,
        `${file}: ${result.success ? "" : JSON.stringify(result.error.format(), null, 2)}`,
      );
    });
  }

  it("critic-response.json validates as ReviewResult when enriched with required fields", () => {
    const partial = loadFixture("critic-response.json");
    const review = ReviewResultSchema.parse({
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      ...partial,
    });
    assert.equal(review.approved, true);
    assert.ok(Array.isArray(review.issues));
  });

  it("topic index shape from director tests validates as TopicIndex", () => {
    const topicIndex = {
      version: "1.0",
      batchId: "testbatch",
      topics: [],
    };
    TopicIndexSchema.parse(topicIndex);
  });

  it("spatial index shape from director tests validates as SpatialIndex", () => {
    const spatialIndex = {
      version: "1.0",
      batchId: "testbatch",
      scenes: [
        {
          sceneId: "clip01_scene001",
          anchors: [
            {
              type: "subject",
              bbox: [0.2, 0.25, 0.4, 0.5],
              timestampSec: 5,
              label: "person",
              confidence: 0.8,
            },
          ],
        },
      ],
    };
    SpatialIndexSchema.parse(spatialIndex);
  });

  it("exported HookCreativeBrief JSON Schema requires unexpectedElement only for unexpected strategy", () => {
    const exportedSchema = JSON.parse(fs.readFileSync(
      path.resolve(FIXTURES_DIR, "../../../schemas/json/AbstractionBundle.schema.json"),
      "utf8",
    ));
    const hookSchema = exportedSchema
      .definitions
      .AbstractionBundle
      .properties
      .L3
      .properties
      .hookCreativeBrief;
    const variants = hookSchema.anyOf ?? hookSchema.oneOf;

    assert.equal(variants?.length, 2);

    const contextual = variants.find(
      (variant) => variant.properties?.strategy?.const === "contextual",
    );
    const unexpected = variants.find(
      (variant) => variant.properties?.strategy?.const === "intentionally_unexpected",
    );

    assert.ok(contextual);
    assert.ok(unexpected);
    assert.equal(contextual.required.includes("unexpectedElement"), false);
    assert.equal(unexpected.required.includes("unexpectedElement"), true);
    assert.deepEqual(
      contextual.properties.mustAvoid.default,
      unexpected.properties.mustAvoid.default,
    );
    assert.equal(contextual.required.includes("visualTone"), false);
    assert.equal(unexpected.required.includes("visualTone"), false);
  });
});
