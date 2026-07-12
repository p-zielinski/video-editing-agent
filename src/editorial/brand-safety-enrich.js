import {
  classifyTextSafety,
  sanitizeTextForSafety,
} from "../lib/profanity-censor.js";

export const DEFAULT_BRAND_SAFETY = Object.freeze({
  enabled: true,
  preset: "social_strict",
  audio: "bleep",
  subtitles: "partial",
  overlays: "partial",
  titles: "partial",
  thumbnails: "partial",
  publishText: "partial",
  llmPrompts: "masked",
});

export function resolveBrandSafety(batchContext = {}) {
  return {
    ...DEFAULT_BRAND_SAFETY,
    ...(batchContext.brandSafety ?? {}),
  };
}

function sanitizeField(target, key, mode, policy) {
  if (!target || typeof target[key] !== "string") {
    return 0;
  }
  const sanitized = sanitizeTextForSafety(target[key], {
    mode,
    brandSafetyEnabled: policy.enabled !== false && policy.preset !== "off",
  });
  if (sanitized === target[key]) {
    return 0;
  }
  target[key] = sanitized;
  return 1;
}

export function enrichRecipeBrandSafetyText(recipe, batchContext = {}) {
  const policy = resolveBrandSafety({
    ...batchContext,
    ...(recipe.batchContext ?? {}),
  });
  if (policy.enabled === false || policy.preset === "off") {
    return 0;
  }

  let changed = 0;
  changed += sanitizeField(recipe.shortsOutroBracket, "text", policy.overlays, policy);

  for (const output of recipe.outputs ?? []) {
    changed += sanitizeField(output, "title", policy.titles, policy);
    changed += sanitizeField(output, "synopsis", policy.publishText, policy);
    for (const segment of output.timeline ?? []) {
      for (const overlay of segment.textOverlays ?? []) {
        changed += sanitizeField(overlay, "text", policy.overlays, policy);
      }
    }
  }

  for (const moment of recipe.creativeMoments ?? []) {
    changed += sanitizeField(moment.params, "text", policy.overlays, policy);
    changed += sanitizeField(moment.params, "title", policy.overlays, policy);
    changed += sanitizeField(moment.params, "caption", policy.overlays, policy);
  }

  return changed;
}

function collectRecipeText(recipe) {
  const entries = [];
  if (recipe.shortsOutroBracket?.text) {
    entries.push({ path: "shortsOutroBracket.text", text: recipe.shortsOutroBracket.text });
  }
  for (const output of recipe.outputs ?? []) {
    if (output.title) {
      entries.push({ path: `outputs.${output.outputId}.title`, text: output.title });
    }
    if (output.synopsis) {
      entries.push({ path: `outputs.${output.outputId}.synopsis`, text: output.synopsis });
    }
    for (const segment of output.timeline ?? []) {
      for (const overlay of segment.textOverlays ?? []) {
        entries.push({
          path: `outputs.${output.outputId}.${segment.segmentId}.${overlay.overlayId}.text`,
          text: overlay.text,
        });
      }
    }
  }
  for (const moment of recipe.creativeMoments ?? []) {
    for (const key of ["text", "title", "caption"]) {
      if (moment.params?.[key]) {
        entries.push({
          path: `creativeMoments.${moment.momentId}.params.${key}`,
          text: moment.params[key],
        });
      }
    }
  }
  return entries;
}

export function findRecipeBrandSafetyViolations(recipe) {
  const policy = resolveBrandSafety(recipe.batchContext ?? {});
  if (policy.enabled === false || policy.preset === "off") {
    return [];
  }
  return collectRecipeText(recipe).flatMap((entry) => {
    const unsafe = classifyTextSafety(entry.text, {
      mode: "partial",
      brandSafetyEnabled: true,
    }).filter((token) =>
      token.safetyAction !== "allow"
      && token.safetyAction !== "review"
      && token.displayWord);
    return unsafe.map((token) => ({
      path: entry.path,
      word: token.word,
      safetyClass: token.safetyClass,
    }));
  });
}
