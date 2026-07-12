import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDeterministicEnricherStepOrder } from "./agents.js";

describe("deterministic enricher order", () => {
  it("runs enrichers in conflict-reducing order", () => {
    const order = getDeterministicEnricherStepOrder();

    assert.deepEqual(order, [
      "stripEnrichBeatsInSlowSegments",
      "enrichRecipeColdOpenSegment",
      "enrichRecipeAiHook",
      "enrichRecipeShortIntroSkip",
      "enrichRecipeFillerCuts",
      "enrichRecipeProfanity",
      "enrichRecipeVoiceDirectives",
      "enrichRecipeDeadAirHandling",
      "enrichRecipePacingTrim",
      "enrichRecipeFastRhythmSpeed",
      "enrichRecipeJlCutSnap",
      "enrichRecipeSfxPlan",
      "enrichRecipeRetentionBeats",
      "enrichRecipePayoffMoments",
      "enrichRecipeCallbackMoments",
      "enrichRecipeClosureCta",
      "enrichRecipeShortsOutroBracket",
      "enrichRecipeChapterCards",
      "enrichRecipeActTransitions",
      "enrichRecipeMusicBeatSnap",
      "enrichBrollSyncFromHints",
      "enrichJumpCutsAsTimeCuts",
      "enrichRecipeBrandSafetyText",
      "enrichRecipeDisableColorGrade",
    ]);
  });
});
