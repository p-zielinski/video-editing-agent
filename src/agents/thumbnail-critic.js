import {
  ThumbnailPlanSchema,
  ThumbnailReviewSchema,
} from "../schemas/thumbnail-plan.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import {
  applyPublishVoiceToPlan,
  applyPublishVoiceToVariant,
  DEFAULT_PUBLISH_VOICE,
  summarizePublishVoiceForPrompt,
} from "../editorial/publish-voice.js";

export function applyThumbnailRevisions(plan, revisedVariants = [], publishVoice = DEFAULT_PUBLISH_VOICE) {
  if (!revisedVariants.length) {
    return plan;
  }

  const outputs = (plan.outputs ?? []).map((outputPlan) => {
    const variants = outputPlan.variants.map((variant) => {
      const revision = revisedVariants.find(
        (entry) => entry.outputId === outputPlan.outputId && entry.variantId === variant.variantId,
      );
      if (!revision) {
        return variant;
      }
      const { outputId: _outputId, ...variantFields } = revision;
      return applyPublishVoiceToVariant({ ...variant, ...variantFields }, publishVoice);
    });

    return { ...outputPlan, variants };
  });

  return applyPublishVoiceToPlan(
    ThumbnailPlanSchema.parse({ ...plan, outputs }),
    publishVoice,
  );
}

export async function runThumbnailCritic(client, {
  thumbnailPlan,
  recipe,
  abstractionL3,
  frameShortlist = {},
  publishVoice = DEFAULT_PUBLISH_VOICE,
}) {
  const system = loadPrompt("thumbnail-critic", { version: "v2" })
    || loadPrompt("thumbnail-critic");

  const userPayload = {
    thumbnailPlan,
    frameShortlist,
    publishVoice,
    voiceGuidance: summarizePublishVoiceForPrompt(publishVoice),
    recipe: {
      batchId: recipe.batchId,
      outputs: (recipe.outputs ?? []).map((output) => ({
        outputId: output.outputId,
        format: output.format,
        title: output.title,
      })),
    },
    abstractionL3,
    outputSchema: {
      approved: "boolean",
      issues: [{
        severity: "error|warning|suggestion",
        code: "string",
        message: "string",
        outputId: "string?",
        variantId: "string?",
      }],
      suggestions: ["string"],
      summary: "string",
      revisedVariants: "optional array with outputId + variant fields",
    },
  };

  const raw = await chatJson(client, {
    model: MODELS.thumbnailCritic,
    system,
    user: JSON.stringify(userPayload),
    temperature: 0.2,
  });

  const review = ThumbnailReviewSchema.parse({
    version: "1.0",
    batchId: recipe.batchId,
    approved: Boolean(raw.approved),
    issues: raw.issues ?? [],
    suggestions: raw.suggestions ?? [],
    summary: raw.summary ?? "",
    revisedVariants: raw.revisedVariants,
  });

  let finalPlan = thumbnailPlan;
  if (!review.approved && review.revisedVariants?.length) {
    finalPlan = applyThumbnailRevisions(thumbnailPlan, review.revisedVariants, publishVoice);
  } else {
    finalPlan = applyPublishVoiceToPlan(thumbnailPlan, publishVoice);
  }

  return { review, plan: finalPlan };
}
