import { createHash } from "node:crypto";
import path from "node:path";
import { writeJson, readJson, ARTIFACTS } from "../pipeline/work-paths.js";

export function hashRecipe(recipe) {
  return createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
}

export function countRecipeSummary(recipe) {
  const outputs = recipe?.outputs ?? [];
  let segments = 0;
  let cuts = 0;
  for (const output of outputs) {
    for (const segment of output.timeline ?? []) {
      segments += 1;
      cuts += (segment.cuts ?? []).length;
    }
  }
  return {
    segments,
    creativeMoments: (recipe?.creativeMoments ?? []).length,
    cuts,
    sfxPlan: (recipe?.sfxPlan ?? []).length,
  };
}

export function snapshotRecipeStage(recipe, stageName) {
  return {
    stageName,
    hash: hashRecipe(recipe),
    ...countRecipeSummary(recipe),
  };
}

export function diffRecipeSummaries(before, after) {
  return {
    segmentsAdded: Math.max(0, after.segments - before.segments),
    segmentsRemoved: Math.max(0, before.segments - after.segments),
    cutsAdded: Math.max(0, after.cuts - before.cuts),
    creativeMomentsAdded: Math.max(0, after.creativeMoments - before.creativeMoments),
    sfxPlanAdded: Math.max(0, after.sfxPlan - before.sfxPlan),
  };
}

/**
 * @param {(recipe: object, context: object) => Array<{ name: string, apply: () => void }>} stepsFn
 */
export function createEnricherAuditWrapper(stepsFn) {
  return (recipe, context) => {
    const enricherLog = [];
    const steps = stepsFn(recipe, context);
    for (const { name, apply } of steps) {
      const before = countRecipeSummary(recipe);
      apply();
      const after = countRecipeSummary(recipe);
      enricherLog.push({
        enricher: name,
        delta: diffRecipeSummaries(before, after),
      });
    }
    return { recipe, enricherLog };
  };
}

export function buildProvenanceDocument({
  batchId,
  afterDirector,
  afterEnrichers,
  afterReview,
  enricherLog = [],
  stitchValidation = null,
  superCriticReview = null,
  reviewIterations = 0,
}) {
  return {
    version: "1.0",
    batchId,
    afterDirector: afterDirector ?? null,
    afterEnrichers: afterEnrichers ?? null,
    afterReview: afterReview ?? null,
    enricherLog,
    stitchValidation,
    superCriticReview,
    reviewIterations,
  };
}

export function stripRecipeProvenanceFields(recipe) {
  const stitchValidation = recipe.stitchValidation ?? null;
  const superCriticReview = recipe.superCriticReview ?? null;
  const { stitchValidation: _sv, superCriticReview: _scr, ...clean } = recipe;
  return { recipe: clean, stitchValidation, superCriticReview };
}

export function writeRecipeProvenance(workDir, doc) {
  const outPath = path.join(workDir, ARTIFACTS.recipeProvenance);
  writeJson(outPath, doc);
  return outPath;
}

export function readRecipeProvenance(workDir) {
  const provenancePath = path.join(workDir, ARTIFACTS.recipeProvenance);
  try {
    return readJson(provenancePath);
  } catch {
    return null;
  }
}
