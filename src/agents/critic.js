import { ReviewResultSchema } from "../schemas/edit-recipe.js";
import { validateRecipeV2 } from "../validators/recipe-v2.js";
import { buildSceneAspectMap } from "../validators/aspect-ratio.js";
import { validateTimelineSegments } from "../validators/scene-registry.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import { formatCatalogForPrompt } from "../editorial/format-catalog-for-prompt.js";
import {
  computeCreativityBudgetForRecipe,
  mergeCreativityProfile,
} from "../editorial/technique-budget.js";
import {
  computeRetentionBeatTargets,
  mergeShortsRetentionProfile,
  mergeVlogRetentionProfile,
  parseRetentionFromContext,
  resolveMainOutputDurationSec,
  resolveShortOutputDurationSec,
  shouldRunShortsRetentionValidation,
  shouldRunVlogRetentionValidation,
} from "../editorial/shorts-retention.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import {
  buildEditorialContext,
  extractSceneIdsFromRecipe,
  spreadEditorialToPayload,
} from "../editorial/editorial-context.js";

function resolveSourceDurationSec(recipe) {
  let sourceDurationSec = (recipe.clipRegistry ?? []).reduce(
    (sum, clip) => sum + (clip.durationSec ?? 0),
    0,
  );
  if (sourceDurationSec <= 0) {
    sourceDurationSec = 600;
  }
  return sourceDurationSec;
}

function buildShortsRetentionCriticContext(recipe) {
  const userContext = recipe.batchContext?.notes ?? "";
  const creativityProfile = recipe.creativityProfile ?? {};
  const requiredFormats = recipe.batchContext?.requiredFormats ?? [];

  if (!shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    creativityProfile,
    userContext,
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    return {};
  }

  const pack = resolveCriticTechniquePack(recipe);
  const catalog = loadTechniqueCatalog({
    pack,
    platforms: recipe.batchContext?.targetPlatforms?.length
      ? recipe.batchContext.targetPlatforms
      : ["youtube", "shorts"],
  });

  const shortsRetention = mergeShortsRetentionProfile(recipe.shortsRetentionProfile ?? {}, {
    packRetentionDefaults: catalog.pack?.retentionDefaults,
    userContext,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    creativityProfile,
  });

  let sourceDurationSec = resolveSourceDurationSec(recipe);

  const shortDurationSec = resolveShortOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
    targetDurationSec: sourceDurationSec,
  });

  const retentionBeatTargets = shortsRetention.enabled
    ? computeRetentionBeatTargets(shortDurationSec, shortsRetention)
    : [];

  return {
    shortsRetentionProfile: shortsRetention,
    retentionBeatTargets: retentionBeatTargets.length ? retentionBeatTargets : undefined,
  };
}

function buildVlogRetentionCriticContext(recipe) {
  const requiredFormats = recipe.batchContext?.requiredFormats ?? [];

  if (!shouldRunVlogRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    vlogRetentionProfile: recipe.vlogRetentionProfile ?? {},
  })) {
    return {};
  }

  const vlogRetention = mergeVlogRetentionProfile(recipe.vlogRetentionProfile ?? {}, {
    outputs: recipe.outputs ?? [],
    requiredFormats,
  });

  if (!vlogRetention.enabled) {
    return {};
  }

  const sourceDurationSec = resolveSourceDurationSec(recipe);
  const mainDurationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
    targetDurationSec: sourceDurationSec,
  });

  const retentionBeatTargetsMain = computeRetentionBeatTargets(
    mainDurationSec,
    vlogRetention,
    { mode: "vlog" },
  );

  return {
    vlogRetentionProfile: vlogRetention,
    retentionBeatTargetsMain: retentionBeatTargetsMain.length
      ? retentionBeatTargetsMain
      : undefined,
  };
}

function resolveCriticTechniquePack(recipe) {
  const userContext = recipe.batchContext?.notes ?? "";
  const retentionContext = parseRetentionFromContext(userContext);
  const creativityProfile = recipe.creativityProfile ?? {};

  if (retentionContext?.techniquePack) {
    return retentionContext.techniquePack;
  }
  if (/shorts:\s*energy\s*high/.test(String(userContext).toLowerCase())) {
    return creativityProfile.techniquePack ?? "shorts_energy";
  }

  const retention = mergeShortsRetentionProfile(recipe.shortsRetentionProfile ?? {}, {
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    creativityProfile,
    userContext,
    packRetentionDefaults: undefined,
  });

  if (shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    creativityProfile,
    userContext,
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    return retention.techniquePack ?? creativityProfile.techniquePack;
  }

  return creativityProfile.techniquePack;
}

function isRecipeV2(version) {
  return version === "2.0" || version === "2.1" || version === "2.2" || version === "2.3" || version === "2.4";
}

function buildCreativityValidationContext(recipe) {
  const pack = resolveCriticTechniquePack(recipe);
  const catalog = loadTechniqueCatalog({
    pack,
    platforms: recipe.batchContext?.targetPlatforms?.length
      ? recipe.batchContext.targetPlatforms
      : ["youtube", "shorts"],
  });
  const profile = mergeCreativityProfile(recipe.creativityProfile ?? {}, {
    defaultCreativityLevel: catalog.pack?.defaultCreativityLevel,
  });
  const budget = computeCreativityBudgetForRecipe(recipe, profile);
  const techniqueCatalog = formatCatalogForPrompt(catalog, budget.byOutputId
    ? Object.values(budget.byOutputId)[0] ?? budget
    : budget);
  return { catalog, budget, techniqueCatalog };
}

export function heuristicReview(recipe, {
  requiredFormats = ["16:9", "9:16"],
  topicIndex,
  spatialIndex,
  timelineIndex,
  wordIndexes = [],
  estimatedKeepRatio,
  audioIndex = null,
  brollSyncHints,
} = {}) {
  if (isRecipeV2(recipe.version)) {
    const { budget } = buildCreativityValidationContext(recipe);
    const sceneAspectById = timelineIndex?.scenes?.length
      ? buildSceneAspectMap(timelineIndex.scenes)
      : undefined;
    return validateRecipeV2(recipe, {
      requiredFormats,
      topicIndex,
      spatialIndex,
      sceneAspectById,
      wordIndexes,
      audioIndex,
      creativityBudget: budget,
      estimatedKeepRatio,
      brollSyncHints,
    }).issues;
  }

  const validation = validateTimelineSegments(recipe);
  return validation;
}

export async function runCritic(client, {
  recipe,
  abstraction,
  timelineIndex,
  topicIndex,
  spatialIndex,
  iteration = 1,
  requiredFormats = ["16:9", "9:16"],
  wordIndexes = [],
  audioIndex = null,
  perClipAnalysis = null,
  brollSyncHints,
}) {
  const heuristicIssues = heuristicReview(recipe, {
    requiredFormats,
    topicIndex,
    spatialIndex,
    timelineIndex,
    wordIndexes,
    audioIndex,
    estimatedKeepRatio: abstraction?.L3?.estimatedKeepRatio,
    brollSyncHints,
  });
  const isV2Recipe = isRecipeV2(recipe.version);
  const system = loadPrompt("critic", { version: isV2Recipe ? "v2" : "v1" })
    || loadPrompt("critic");

  let techniqueCatalog;
  if (isV2Recipe && (recipe.creativeMoments?.length || recipe.version !== "2.0")) {
    ({ techniqueCatalog } = buildCreativityValidationContext(recipe));
  }

  const usedSceneIds = new Set(extractSceneIdsFromRecipe(recipe));

  const includeSpatial = isV2Recipe
    && spatialIndex
    && (recipe.creativeMoments?.length || recipe.version !== "2.0");

  const editorialContext = buildEditorialContext({
    timelineIndex,
    recipe,
    audioIndex,
    topicIndex,
    spatialIndex: includeSpatial ? spatialIndex : undefined,
    includeFullTopicIndex: false,
    perClipAnalysis,
    wordIndexes,
  });

  const retentionContext = {
    ...buildShortsRetentionCriticContext(recipe),
    ...buildVlogRetentionCriticContext(recipe),
  };

  const userPayload = {
    recipe,
    sessionSummary: abstraction.L3,
    heuristicIssues,
    techniqueCatalog,
    ...retentionContext,
    iteration,
    outputSchema: {
      approved: "boolean",
      issues: [{ severity: "error|warning|suggestion", code: "string", message: "string" }],
      summary: "string",
    },
  };

  if (timelineIndex) {
    userPayload.timelineCrossCheck = {
      scenes: timelineIndex.scenes
        .filter((scene) => usedSceneIds.has(scene.sceneId))
        .map((scene) => ({
          sceneId: scene.sceneId,
          clipId: scene.clipId,
          aspectRatio: scene.aspectRatio,
          hasSpeech: scene.hasSpeech,
          wordRange: scene.wordRange,
        })),
      visionCaptions: (timelineIndex.visionCaptions ?? []).filter((caption) =>
        usedSceneIds.has(caption.sceneId),
      ),
    };
  }

  spreadEditorialToPayload(userPayload, editorialContext, { nestKey: "timelineCrossCheck" });

  const user = JSON.stringify(userPayload);

  const raw = await chatJson(client, {
    model: MODELS.critic,
    system,
    user,
    temperature: 0.2,
  });

  const mergedIssues = [...heuristicIssues];
  for (const issue of raw.issues ?? []) {
    const duplicate = mergedIssues.some(
      (h) => h.code === issue.code && h.message === issue.message,
    );
    if (!duplicate) {
      mergedIssues.push(issue);
    }
  }

  const hasErrors = mergedIssues.some((i) => i.severity === "error");

  return ReviewResultSchema.parse({
    version: "1.0",
    batchId: recipe.batchId,
    iteration,
    approved: !hasErrors && Boolean(raw.approved),
    issues: mergedIssues,
    summary: raw.summary ?? "",
  });
}
