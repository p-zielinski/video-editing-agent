import { ReviewResultSchema } from "../schemas/edit-recipe.js";
import { validateRecipeV2 } from "../validators/recipe-v2.js";
import { validateTimelineSegments } from "../validators/scene-registry.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import { formatCatalogForPrompt } from "../editorial/format-catalog-for-prompt.js";
import {
  computeCreativityBudget,
  mergeCreativityProfile,
} from "../editorial/technique-budget.js";
import {
  computeRetentionBeatTargets,
  mergeShortsRetentionProfile,
  parseRetentionFromContext,
  resolveShortOutputDurationSec,
  shouldRunShortsRetentionValidation,
} from "../editorial/shorts-retention.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";
import {
  buildEditorialContext,
  extractSceneIdsFromRecipe,
  spreadEditorialToPayload,
} from "../editorial/editorial-context.js";

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

  let sourceDurationSec = (recipe.clipRegistry ?? []).reduce(
    (sum, clip) => sum + (clip.durationSec ?? 0),
    0,
  );
  if (sourceDurationSec <= 0) {
    sourceDurationSec = 600;
  }

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
  let durationSec = 0;
  for (const output of recipe.outputs ?? []) {
    for (const seg of output.timeline) {
      const end = seg.outputEndSec
        ?? (seg.outputStartSec ?? 0) + (seg.videoOutSec - seg.videoInSec);
      durationSec = Math.max(durationSec, end);
    }
  }
  if (durationSec <= 0) {
    durationSec = (recipe.clipRegistry ?? []).reduce(
      (sum, c) => sum + (c.durationSec ?? 0),
      0,
    ) || 600;
  }
  const budget = computeCreativityBudget(durationSec, profile);
  const techniqueCatalog = formatCatalogForPrompt(catalog, budget);
  return { catalog, budget, techniqueCatalog };
}

export function heuristicReview(recipe, {
  requiredFormats = ["16:9", "9:16"],
  topicIndex,
  spatialIndex,
  wordIndexes = [],
  estimatedKeepRatio,
} = {}) {
  if (recipe.version === "2.0" || recipe.version === "2.1" || recipe.version === "2.2" || recipe.version === "2.3") {
    const { catalog, budget } = buildCreativityValidationContext(recipe);
    return validateRecipeV2(recipe, {
      requiredFormats,
      topicIndex,
      spatialIndex,
      wordIndexes,
      techniqueCatalog: catalog,
      creativityBudget: budget,
      estimatedKeepRatio,
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
}) {
  const heuristicIssues = heuristicReview(recipe, {
    requiredFormats,
    topicIndex,
    spatialIndex,
    wordIndexes,
    estimatedKeepRatio: abstraction?.L3?.estimatedKeepRatio,
  });
  const isV2Recipe = recipe.version === "2.0" || recipe.version === "2.1" || recipe.version === "2.2" || recipe.version === "2.3";
  const system = loadPrompt("critic", { version: isV2Recipe ? "v2" : "v1" })
    || loadPrompt("critic");

  let techniqueCatalog;
  if (isV2Recipe && (recipe.creativeMoments?.length || recipe.version === "2.1" || recipe.version === "2.2" || recipe.version === "2.3")) {
    ({ techniqueCatalog } = buildCreativityValidationContext(recipe));
  }

  const usedSceneIds = new Set(extractSceneIdsFromRecipe(recipe));

  const includeSpatial = isV2Recipe
    && spatialIndex
    && (recipe.creativeMoments?.length || recipe.version === "2.1" || recipe.version === "2.2" || recipe.version === "2.3");

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

  const retentionContext = buildShortsRetentionCriticContext(recipe);

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
