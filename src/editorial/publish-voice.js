import { z } from "zod";
import { parseBatchContextFromUserContext } from "../lib/input-mode.js";

export const DescriptionVoiceRulesSchema = z.object({
  maxSentences: z.number().int().positive().default(2),
  noClickbait: z.boolean().default(true),
  noQuestions: z.boolean().default(true),
  allLowercase: z.boolean().default(true),
  noExclamation: z.boolean().default(true),
  noRepeatHeadline: z.boolean().default(true),
});

export const PublishVoiceSchema = z.object({
  thumbnailVoice: z.enum(["loud", "balanced"]).default("loud"),
  titleVoice: z.enum(["loud", "curious", "lowercase_casual"]).default("lowercase_casual"),
  descriptionVoice: z.enum(["marketing", "lowercase_casual", "utility"]).default("lowercase_casual"),
  descriptionRules: DescriptionVoiceRulesSchema.default({}),
});

export const DEFAULT_PUBLISH_VOICE = PublishVoiceSchema.parse({});

function splitSentences(text) {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Quiet layer — YouTube description copy (utility, not second hook).
 */
export function formatDescriptionForVoice(text, publishVoice = DEFAULT_PUBLISH_VOICE) {
  if (!text || typeof text !== "string") {
    return text;
  }

  const rules = publishVoice.descriptionRules ?? DEFAULT_PUBLISH_VOICE.descriptionRules;
  let result = text.trim();

  if (rules.noExclamation) {
    result = result.replace(/!+/g, "");
  }

  if (rules.noQuestions) {
    result = result.replace(/\?+/g, "");
  }

  if (rules.maxSentences > 0) {
    const sentences = splitSentences(result);
    result = sentences.slice(0, rules.maxSentences).join(" ");
  }

  if (publishVoice.descriptionVoice === "lowercase_casual"
    || publishVoice.descriptionVoice === "utility") {
    if (rules.allLowercase) {
      result = result.toLowerCase();
    }
  }

  return result.replace(/\s{2,}/g, " ").trim();
}

/**
 * Middle layer — title A/B: curious but not thumbnail-shouty.
 */
export function formatTitleForVoice(text, publishVoice = DEFAULT_PUBLISH_VOICE) {
  if (!text || typeof text !== "string") {
    return text;
  }

  let result = text.trim();

  if (publishVoice.titleVoice === "lowercase_casual") {
    result = result.toLowerCase();
    result = result.replace(/!+/g, "");
  } else if (publishVoice.titleVoice === "curious") {
    result = result.replace(/!{2,}/g, "!");
    if (!publishVoice.descriptionRules?.allLowercase) {
      return result.trim();
    }
    result = result.toLowerCase();
  }

  return result.replace(/\s{2,}/g, " ").trim();
}

export function mergePublishVoice(partial = {}) {
  return PublishVoiceSchema.parse({
    ...DEFAULT_PUBLISH_VOICE,
    ...partial,
    descriptionRules: {
      ...DEFAULT_PUBLISH_VOICE.descriptionRules,
      ...(partial.descriptionRules ?? {}),
    },
  });
}

export function resolvePublishVoice({
  batchContext = {},
  userContext = "",
} = {}) {
  const fromUserContext = parseBatchContextFromUserContext(userContext);
  return mergePublishVoice({
    ...DEFAULT_PUBLISH_VOICE,
    ...(batchContext.publishVoice ?? {}),
    ...(fromUserContext.publishVoice ?? {}),
    descriptionRules: {
      ...DEFAULT_PUBLISH_VOICE.descriptionRules,
      ...(batchContext.publishVoice?.descriptionRules ?? {}),
      ...(fromUserContext.publishVoice?.descriptionRules ?? {}),
    },
  });
}

export function applyPublishVoiceToVariant(variant, publishVoice = DEFAULT_PUBLISH_VOICE) {
  return {
    ...variant,
    titleVariant: formatTitleForVoice(variant.titleVariant, publishVoice),
    descriptionVariant: variant.descriptionVariant == null
      ? variant.descriptionVariant
      : formatDescriptionForVoice(variant.descriptionVariant, publishVoice),
  };
}

export function applyPublishVoiceToPlan(plan, publishVoice = DEFAULT_PUBLISH_VOICE) {
  const outputs = (plan.outputs ?? []).map((outputPlan) => ({
    ...outputPlan,
    variants: outputPlan.variants.map((variant) =>
      applyPublishVoiceToVariant(variant, publishVoice),
    ),
  }));

  return {
    ...plan,
    publishVoice,
    outputs,
  };
}

/**
 * Compact rules for GPT prompts (strategist / critic).
 */
export function summarizePublishVoiceForPrompt(publishVoice = DEFAULT_PUBLISH_VOICE) {
  const rules = publishVoice.descriptionRules ?? DEFAULT_PUBLISH_VOICE.descriptionRules;

  return {
    lanes: {
      headline: publishVoice.thumbnailVoice === "loud"
        ? "WARSTWA GŁOŚNA — max 5 słów, emocja, pytanie lub liczba; CAPS OK (renderer i tak kapitalizuje)"
        : "Średnia energia — czytelny hook bez przesady",
      titleVariant: publishVoice.titleVoice === "lowercase_casual"
        ? "ŚREDNIA warstwa — małymi literami, ciekawy kąt, bez CAPS i bez wykrzykników"
        : publishVoice.titleVoice === "curious"
          ? "ŚREDNIA warstwa — intrygujący tytuł, bez powtarzania headline"
          : "Może być mocniejszy, ale nie duplikuj headline",
      descriptionVariant: publishVoice.descriptionVoice === "marketing"
        ? "Marketingowy opis (wyjątek od profilu)"
        : "CICHA warstwa — notatka pod filmem, nie drugi hook; małymi literami, bez pytań i wykrzykników",
    },
    descriptionRules: rules,
    doNotRepeat: "descriptionVariant NIE może powtarzać headline ani titleVariant — klik już był",
  };
}
