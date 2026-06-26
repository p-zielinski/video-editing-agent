import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCritic } from "../../src/agents/critic.js";
import { runFixer } from "../../src/agents/fixer.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import { createMockOpenAIClient, loadFixture } from "../../src/agents/test-helpers.js";

function buildBrokenV21Recipe() {
  return {
    ...loadFixture("recipe-draft.json"),
    version: "2.1",
    creativityProfile: {
      level: "balanced",
      allowMidSentenceCuts: false,
      techniquePack: "youtube_vlog_2026",
    },
    creativeMoments: [{
      momentId: "cm_bad",
      techniqueId: "nonexistent_technique",
      outputId: "horizontal_main",
      outputStartSec: 5,
      outputEndSec: 6,
      segmentId: "seg_h1",
      reason: "intentional V21-01 for critic/fixer loop",
    }],
  };
}

function buildFixedRecipe(broken) {
  return {
    ...broken,
    creativeMoments: [],
  };
}

describe("critic/fixer loop E2E", () => {
  it("flags V21 issue via critic heuristics, repairs via fixer, passes validateRecipeV2", async () => {
    const brokenRecipe = buildBrokenV21Recipe();
    const fixedRecipe = buildFixedRecipe(brokenRecipe);
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const topicIndex = {
      version: "1.0",
      batchId: "testbatch",
      topics: [],
    };
    const spatialIndex = {
      version: "1.0",
      batchId: "testbatch",
      scenes: [],
    };

    const criticResponse = {
      approved: false,
      issues: [{
        severity: "error",
        code: "V21-01",
        message: "Technika nonexistent_technique nie istnieje w katalogu",
      }],
      summary: "Nieznana technika w creativeMoments — wymaga naprawy",
    };

    const client = createMockOpenAIClient([criticResponse, fixedRecipe]);

    const review = await runCritic(client, {
      recipe: brokenRecipe,
      abstraction,
      timelineIndex,
      topicIndex,
      spatialIndex,
      iteration: 1,
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(review.approved, false);
    assert.ok(
      review.issues.some((issue) => issue.code === "V21-01"),
      `expected V21-01 in review issues, got: ${review.issues.map((i) => i.code).join(", ")}`,
    );

    const repaired = await runFixer(client, {
      recipe: brokenRecipe,
      review,
      abstraction,
      topicIndex,
      spatialIndex,
    });

    const validation = validateRecipeV2(repaired, {
      requiredFormats: ["16:9", "9:16"],
      topicIndex,
      spatialIndex,
    });

    assert.equal(validation.valid, true);
    assert.equal(repaired.creativeMoments.length, 0);
  });
});
