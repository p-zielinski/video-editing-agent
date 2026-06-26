import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyThumbnailRevisions, runThumbnailCritic } from "./thumbnail-critic.js";
import { buildStubThumbnailPlan } from "./thumbnail-strategist.js";
import { createMockOpenAIClient } from "./test-helpers.js";
import { loadFixtureArtifact } from "../test-helpers/fixture-work-dir.js";

const recipe = loadFixtureArtifact("mini-day", "golden-recipe-v2.json");
const abstraction = loadFixtureArtifact("mini-day", "06-abstract.json");

describe("thumbnail-critic agent", () => {
  it("merges revised variants when critic rejects plan", async () => {
    const plan = buildStubThumbnailPlan({
      recipe,
      frameShortlistByOutput: {
        horizontal_main: [{
          clipId: "clip01",
          sceneId: "clip01_scene001",
          timestampSec: 8,
          score: 0.9,
          hasFace: true,
          visualQuality: "high",
        }],
      },
    });

    const criticResponse = {
      approved: false,
      issues: [{
        severity: "warning",
        code: "HEADLINE_LENGTH",
        message: "Headline za długi",
        outputId: "horizontal_main",
        variantId: plan.outputs[0].variants[1].variantId,
      }],
      suggestions: ["Skróć headline"],
      summary: "Wymaga drobnej korekty",
      revisedVariants: [{
        outputId: "horizontal_main",
        ...plan.outputs[0].variants[1],
        headline: "RESTAURACJA DZIŚ",
      }],
    };

    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });
    const { review, plan: revisedPlan } = await runThumbnailCritic(client, {
      thumbnailPlan: plan,
      recipe,
      abstractionL3: abstraction.L3,
    });

    assert.equal(review.approved, false);
    assert.equal(revisedPlan.outputs[0].variants[1].headline, "RESTAURACJA DZIŚ");

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.thumbnailPlan.outputs.length, plan.outputs.length);
  });

  it("applyThumbnailRevisions updates only matching variants", () => {
    const plan = buildStubThumbnailPlan({ recipe, frameShortlistByOutput: {} });
    const variantId = plan.outputs[0].variants[0].variantId;
    const revised = applyThumbnailRevisions(plan, [{
      outputId: plan.outputs[0].outputId,
      ...plan.outputs[0].variants[0],
      headline: "NOWY HOOK",
    }]);

    assert.equal(revised.outputs[0].variants[0].headline, "NOWY HOOK");
    assert.notEqual(revised.outputs[0].variants[1].headline, "NOWY HOOK");
    assert.equal(revised.outputs[0].variants[0].variantId, variantId);
  });
});
