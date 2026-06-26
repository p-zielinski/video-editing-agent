import {
  ThumbnailPlanSchema,
  ThumbnailVariantSchema,
} from "../schemas/thumbnail-plan.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import {
  applyPublishVoiceToPlan,
  DEFAULT_PUBLISH_VOICE,
  formatDescriptionForVoice,
  formatTitleForVoice,
  summarizePublishVoiceForPrompt,
} from "../editorial/publish-voice.js";

const STRATEGY_STYLES = {
  safe: "frame_only",
  controlled: "frame_plus_text",
  risk: "frame_text_accent",
};

function truncateHeadline(text, maxWords = 5) {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ");
}

export function snapSourceRefToShortlist(sourceRef, shortlist = []) {
  if (!shortlist.length) {
    return sourceRef;
  }

  const exact = shortlist.find(
    (entry) => entry.sceneId === sourceRef.sceneId
      && Math.abs(entry.timestampSec - sourceRef.timestampSec) < 0.5,
  );
  if (exact) {
    return {
      clipId: exact.clipId,
      sceneId: exact.sceneId,
      timestampSec: exact.timestampSec,
    };
  }

  const sameScene = shortlist.find((entry) => entry.sceneId === sourceRef.sceneId);
  if (sameScene) {
    return {
      clipId: sameScene.clipId,
      sceneId: sameScene.sceneId,
      timestampSec: sameScene.timestampSec,
    };
  }

  const fallback = shortlist[0];
  return {
    clipId: fallback.clipId,
    sceneId: fallback.sceneId,
    timestampSec: fallback.timestampSec,
  };
}

function normalizeStrategistPlan(raw, recipe, frameShortlist, publishVoice = DEFAULT_PUBLISH_VOICE) {
  const outputs = (raw.outputs ?? []).map((outputPlan) => {
    const shortlist = frameShortlist[outputPlan.outputId] ?? [];
    const variants = (outputPlan.variants ?? []).map((variant) =>
      ThumbnailVariantSchema.parse({
        ...variant,
        sourceRef: snapSourceRefToShortlist(variant.sourceRef, shortlist),
      }),
    );

    return {
      ...outputPlan,
      variants,
    };
  });

  return applyPublishVoiceToPlan(
    ThumbnailPlanSchema.parse({
      version: "1.0",
      batchId: recipe.batchId,
      outputs,
    }),
    publishVoice,
  );
}

function pickFrame(shortlist, index) {
  if (!shortlist?.length) {
    return null;
  }
  return shortlist[Math.min(index, shortlist.length - 1)];
}

function buildStubVariant({
  output,
  strategy,
  index,
  shortlist,
  publishVoice = DEFAULT_PUBLISH_VOICE,
}) {
  const frame = pickFrame(shortlist, index);
  const baseTitle = output.title ?? output.outputId;
  const headlines = {
    safe: truncateHeadline(baseTitle),
    controlled: truncateHeadline(`${baseTitle} dziś`),
    risk: truncateHeadline("musisz to zobaczyć"),
  };

  const rawDescription = strategy === "safe"
    ? `${baseTitle}. krótka notatka pod filmem.`
    : `${baseTitle} — wariant ${strategy}.`;

  return ThumbnailVariantSchema.parse({
    variantId: `${strategy}_${String(index + 1).padStart(2, "0")}`,
    strategy,
    sourceRef: frame ?? {
      clipId: "clip01",
      sceneId: "clip01_scene001",
      timestampSec: 0,
    },
    headline: headlines[strategy],
    titleVariant: formatTitleForVoice(`${baseTitle} — wariant ${strategy}`, publishVoice),
    descriptionVariant: formatDescriptionForVoice(rawDescription, publishVoice),
    style: STRATEGY_STYLES[strategy],
    rationale: `Stub: deterministyczny wariant ${strategy} dla testów`,
  });
}

export function buildStubThumbnailPlan({
  recipe,
  frameShortlistByOutput = {},
  publishVoice = DEFAULT_PUBLISH_VOICE,
}) {
  const outputs = (recipe.outputs ?? []).map((output) => {
    const shortlist = frameShortlistByOutput[output.outputId] ?? [];
    const strategies = ["safe", "controlled", "risk"];
    const variants = strategies.map((strategy, index) =>
      buildStubVariant({ output, strategy, index, shortlist, publishVoice }),
    );

    return {
      outputId: output.outputId,
      format: output.format,
      variants,
    };
  });

  return applyPublishVoiceToPlan(
    ThumbnailPlanSchema.parse({
      version: "1.0",
      batchId: recipe.batchId,
      outputs,
    }),
    publishVoice,
  );
}

export async function runThumbnailStrategist(client, {
  recipe,
  frameShortlist,
  abstractionL3,
  userContext = "",
  publishVoice = DEFAULT_PUBLISH_VOICE,
}) {
  const system = loadPrompt("thumbnail-strategist", { version: "v2" })
    || loadPrompt("thumbnail-strategist");

  const userPayload = {
    recipe: {
      batchId: recipe.batchId,
      outputs: (recipe.outputs ?? []).map((output) => ({
        outputId: output.outputId,
        format: output.format,
        title: output.title,
        synopsis: output.synopsis,
      })),
    },
    frameShortlist,
    abstractionL3,
    userContext,
    publishVoice,
    voiceGuidance: summarizePublishVoiceForPrompt(publishVoice),
    outputSchema: {
      outputs: [{
        outputId: "string",
        format: "16:9|9:16",
        variants: [{
          variantId: "string",
          strategy: "safe|controlled|risk",
          sourceRef: { clipId: "string", sceneId: "string", timestampSec: "number" },
          headline: "string (max 5 words)",
          titleVariant: "string",
          descriptionVariant: "string (YouTube description A/B, 1-2 sentences)",
          style: "frame_only|frame_plus_text|frame_text_accent",
          rationale: "string",
        }],
      }],
    },
  };

  const raw = await chatJson(client, {
    model: MODELS.thumbnailStrategist,
    system,
    user: JSON.stringify(userPayload),
    temperature: 0.5,
  });

  return normalizeStrategistPlan(raw, recipe, frameShortlist, publishVoice);
}
