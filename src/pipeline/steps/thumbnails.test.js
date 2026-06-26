import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runThumbnailsStep } from "./thumbnails.js";
import { ARTIFACTS } from "../work-paths.js";
import {
  cleanupWorkDir,
  copyFixtureToWorkDir,
  loadFixtureArtifact,
} from "../../test-helpers/fixture-work-dir.js";
import { ThumbnailPlanSchema, ThumbnailReviewSchema } from "../../schemas/thumbnail-plan.js";
import { createMockOpenAIClient } from "../../agents/test-helpers.js";
import { buildStubThumbnailPlan } from "../../agents/thumbnail-strategist.js";

describe("thumbnails pipeline step", () => {
  let workDir;

  after(() => {
    cleanupWorkDir(workDir);
  });

  it("writes stub plan and review from mini-day fixture", async () => {
    workDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-thumb-step" });
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    fs.writeFileSync(
      path.join(workDir, ARTIFACTS.recipeFinal),
      `${JSON.stringify(recipe, null, 2)}\n`,
      "utf8",
    );

    const result = await runThumbnailsStep({
      workDir,
      apiKey: "unused",
      thumbnailStub: true,
      renderImages: false,
    });

    const plan = ThumbnailPlanSchema.parse(result.plan);
    const review = ThumbnailReviewSchema.parse(result.review);

    assert.equal(plan.version, "1.0");
    assert.equal(plan.batchId, recipe.batchId);
    assert.equal(plan.outputs.length, recipe.outputs.length);
    for (const outputPlan of plan.outputs) {
      assert.equal(outputPlan.variants.length, 3);
      const strategies = outputPlan.variants.map((variant) => variant.strategy);
      assert.deepEqual(new Set(strategies), new Set(["safe", "controlled", "risk"]));
    }

    assert.equal(review.approved, true);
    assert.equal(plan.publishVoice?.descriptionVoice, "lowercase_casual");
    for (const outputPlan of plan.outputs) {
      for (const variant of outputPlan.variants) {
        if (variant.descriptionVariant) {
          assert.equal(variant.descriptionVariant, variant.descriptionVariant.toLowerCase());
        }
      }
    }
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.thumbnailPlan)), true);
    assert.equal(fs.existsSync(path.join(workDir, ARTIFACTS.thumbnailReview)), true);
  });

  it("persists critic revisions in final plan artifact", async () => {
    const localWorkDir = copyFixtureToWorkDir("mini-day", { prefix: "vea-thumb-critic" });
    const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
    fs.writeFileSync(
      path.join(localWorkDir, ARTIFACTS.recipeFinal),
      `${JSON.stringify(recipe, null, 2)}\n`,
      "utf8",
    );

    const stubPlan = buildStubThumbnailPlan({ recipe, frameShortlistByOutput: {} });
    const revisedHeadline = "POPRAWIONY HOOK";
    const criticResponse = {
      approved: false,
      issues: [{
        severity: "warning",
        code: "HEADLINE_LENGTH",
        message: "Headline za długi",
        outputId: stubPlan.outputs[0].outputId,
        variantId: stubPlan.outputs[0].variants[1].variantId,
      }],
      suggestions: ["Skróć headline"],
      summary: "Wymaga drobnej korekty",
      revisedVariants: [{
        outputId: stubPlan.outputs[0].outputId,
        ...stubPlan.outputs[0].variants[1],
        headline: revisedHeadline,
      }],
    };

    const client = createMockOpenAIClient([
      { outputs: stubPlan.outputs },
      criticResponse,
    ]);

    await runThumbnailsStep({
      workDir: localWorkDir,
      openaiClient: client,
      renderImages: false,
    });

    const writtenPlan = ThumbnailPlanSchema.parse(
      JSON.parse(fs.readFileSync(path.join(localWorkDir, ARTIFACTS.thumbnailPlan), "utf8")),
    );
    assert.equal(writtenPlan.outputs[0].variants[1].headline, revisedHeadline);

    cleanupWorkDir(localWorkDir);
  });
});
