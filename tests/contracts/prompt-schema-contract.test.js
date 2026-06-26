import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";
import { EDIT_RECIPE_V2_OUTPUT_SCHEMA } from "../../src/agents/director.js";
import {
  collectPromptSchemaPaths,
  collectZodSchemaPaths,
  pathMatchesPrompt,
  pathMatchesZod,
} from "./helpers/schema-keys.js";

/** Critical director → EditRecipeV2 field paths (must stay in sync). */
const CRITICAL_PATHS = [
  "version",
  "batchId",
  "batchContext.inputMode",
  "batchContext.requiredFormats",
  "batchContext.brollStrategy",
  "batchContext.brollMatchThreshold",
  "batchContext.qualityOverQuantity",
  "batchContext.allowBrollReuse",
  "batchContext.maxBrollSegmentsPerOutput",
  "batchContext.shortsStrategy",
  "batchContext.shortsMaxDurationSec",
  "creativityProfile.level",
  "creativityProfile.allowMidSentenceCuts",
  "creativityProfile.techniquePack",
  "creativityProfile.maxTechniqueDensityPerMin",
  "shortsRetentionProfile.enabled",
  "shortsRetentionProfile.hookWindowSec",
  "shortsRetentionProfile.retentionBeatIntervalSec",
  "shortsRetentionProfile.requireHookMoment",
  "shortsRetentionProfile.requireHookOverlay",
  "shortsRetentionProfile.techniquePack",
  "audioMixPlan.voiceTargetLufs",
  "audioMixPlan.musicBed",
  "audioMixPlan.preWhisperNormalizeLufs",
  "audioMixPlan.segments[].outputId",
  "audioMixPlan.segments[].musicInSec",
  "audioMixPlan.segments[].musicOutSec",
  "audioMixPlan.segments[].duckUnderVoice",
  "creativeMoments[].momentId",
  "creativeMoments[].techniqueId",
  "creativeMoments[].outputId",
  "creativeMoments[].outputStartSec",
  "creativeMoments[].outputEndSec",
  "creativeMoments[].params",
  "creativeMoments[].retentionRole",
  "creativeMoments[].reason",
  "creativeMoments[].confidence",
  "clipRegistry",
  "outputs[].outputId",
  "outputs[].format",
  "outputs[].outputKind",
  "outputs[].title",
  "outputs[].timeline[].segmentId",
  "outputs[].timeline[].segmentRole",
  "outputs[].timeline[].videoRef",
  "outputs[].timeline[].audioRef",
  "outputs[].timeline[].videoInSec",
  "outputs[].timeline[].videoOutSec",
  "outputs[].timeline[].audioInSec",
  "outputs[].timeline[].audioOutSec",
  "outputs[].timeline[].audioPolicy",
  "outputs[].timeline[].syncMode",
  "outputs[].timeline[].cuts",
  "outputs[].timeline[].intent",
  "excluded[].exclusionType",
  "excluded[].clipId",
  "excluded[].sceneId",
  "excluded[].usableAsBroll",
  "excluded[].reason",
  "sceneUsageRegistry",
];

describe("prompt-schema contract: director output vs EditRecipeV2", () => {
  const promptPaths = collectPromptSchemaPaths(EDIT_RECIPE_V2_OUTPUT_SCHEMA);
  const zodPaths = collectZodSchemaPaths(EditRecipeV2Schema);

  it("EditRecipeV2Schema parses without throwing", () => {
    assert.equal(EditRecipeV2Schema._def.typeName, "ZodObject");
  });

  it("director prompt schema defines version 2.3", () => {
    assert.equal(EDIT_RECIPE_V2_OUTPUT_SCHEMA.version, "2.3");
  });

  for (const criticalPath of CRITICAL_PATHS) {
    it(`critical path "${criticalPath}" exists in director prompt schema`, () => {
      assert.ok(
        pathMatchesPrompt(criticalPath, promptPaths),
        `Missing in EDIT_RECIPE_V2_OUTPUT_SCHEMA: ${criticalPath}`,
      );
    });

    it(`critical path "${criticalPath}" is covered by EditRecipeV2 Zod schema`, () => {
      assert.ok(
        pathMatchesZod(criticalPath, zodPaths),
        `Missing in EditRecipeV2Schema: ${criticalPath}`,
      );
    });
  }

  it("Zod schema includes fields director may omit (needsHumanReview)", () => {
    assert.ok(zodPaths.has("needsHumanReview"));
    assert.ok(zodPaths.has("reviewNotes"));
  });
});
