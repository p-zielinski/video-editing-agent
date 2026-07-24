import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RecipeEditorialAssessmentSchema } from "./edit-recipe-v2.js";

const baseAssessment = {
  summary: "Material is usable with light trims.",
  strengths: [],
  blockingIssues: [],
};

describe("RecipeEditorialVerdictSchema", () => {
  it("coerces L3 strong to publishable_as_is", () => {
    const parsed = RecipeEditorialAssessmentSchema.parse({
      ...baseAssessment,
      verdict: "strong",
    });
    assert.equal(parsed.verdict, "publishable_as_is");
  });

  it("coerces viable and publishable to publishable_as_is", () => {
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "viable" }).verdict,
      "publishable_as_is",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "publishable" }).verdict,
      "publishable_as_is",
    );
  });

  it("coerces salvageable and salvage to salvage_required", () => {
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "salvageable" }).verdict,
      "salvage_required",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "salvage" }).verdict,
      "salvage_required",
    );
  });

  it("coerces not_viable, weak, and poor to not_recommended", () => {
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "not_viable" }).verdict,
      "not_recommended",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "weak" }).verdict,
      "not_recommended",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "poor" }).verdict,
      "not_recommended",
    );
  });

  it("defaults unknown verdicts to salvage_required", () => {
    const parsed = RecipeEditorialAssessmentSchema.parse({
      ...baseAssessment,
      verdict: "foobar",
    });
    assert.equal(parsed.verdict, "salvage_required");
  });

  it("preserves canonical recipe verdict values", () => {
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "publishable_as_is" }).verdict,
      "publishable_as_is",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "salvage_required" }).verdict,
      "salvage_required",
    );
    assert.equal(
      RecipeEditorialAssessmentSchema.parse({ ...baseAssessment, verdict: "not_recommended" }).verdict,
      "not_recommended",
    );
  });
});
