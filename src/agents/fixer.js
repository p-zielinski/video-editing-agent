import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { formatCatalogForPrompt } from "../editorial/format-catalog-for-prompt.js";
import { loadTechniqueCatalog } from "../editorial/load-technique-catalog.js";
import {
  computeCreativityBudget,
  mergeCreativityProfile,
} from "../editorial/technique-budget.js";
import {
  computeRetentionBeatTargets,
  mergeShortsRetentionProfile,
  resolveShortOutputDurationSec,
  shouldRunShortsRetentionValidation,
} from "../editorial/shorts-retention.js";
import {
  buildEditorialContext,
  spreadEditorialToPayload,
} from "../editorial/editorial-context.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

function resolveFixerPromptVersion(recipe) {
  if (recipe.version === "2.0" || recipe.version === "2.1" || recipe.version === "2.2" || recipe.version === "2.3") {
    return "v2";
  }
  return "v1";
}

function buildWordIdHint(wordIndexes = [], timelineIndex) {
  const words = wordIndexes.flatMap((index) => index.words ?? []);
  if (words.length > 0) {
    return {
      wordCount: words.length,
      wordIdSample: words.slice(0, 24).map((word) => word.wordId),
    };
  }

  const timelineWords = timelineIndex?.words ?? [];
  if (timelineWords.length === 0) {
    return undefined;
  }

  return {
    wordCount: timelineWords.length,
    wordIdSample: timelineWords.slice(0, 24).map((word) => word.wordId),
  };
}

function buildTechniqueCatalog(recipe) {
  const creativityProfile = mergeCreativityProfile(recipe.creativityProfile ?? {}, {});
  const packId = creativityProfile.techniquePack ?? "youtube_vlog_2026";
  const catalog = loadTechniqueCatalog({
    pack: packId,
    platforms: recipe.batchContext?.targetPlatforms?.length
      ? recipe.batchContext.targetPlatforms
      : ["youtube", "shorts"],
  });
  const durationSec = resolveShortOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  }) || 600;
  const budget = computeCreativityBudget(durationSec, creativityProfile);
  return formatCatalogForPrompt(catalog, budget);
}

function buildRepairContext({
  recipe,
  timelineIndex,
  audioIndex,
  topicIndex,
  spatialIndex,
  wordIndexes,
  perClipAnalysis,
}) {
  const hasCreativeLayer = recipe.version === "2.1"
    || recipe.version === "2.2"
    || recipe.version === "2.3"
    || (recipe.creativeMoments?.length ?? 0) > 0;

  const editorial = buildEditorialContext({
    timelineIndex,
    recipe,
    audioIndex,
    topicIndex,
    spatialIndex: hasCreativeLayer ? spatialIndex : undefined,
    includeFullTopicIndex: false,
    perClipAnalysis,
    wordIndexes,
  });

  const context = spreadEditorialToPayload({}, editorial);

  if (editorial.transcriptExcerpts.length === 0) {
    const wordIdHint = buildWordIdHint(wordIndexes, timelineIndex);
    if (wordIdHint) {
      context.wordIdHint = wordIdHint;
    }
  }

  return context;
}

function buildCreativeFixerContext({ recipe }) {
  const hasCreativeLayer = recipe.version === "2.1"
    || recipe.version === "2.2"
    || recipe.version === "2.3"
    || (recipe.creativeMoments?.length ?? 0) > 0;

  if (!hasCreativeLayer) {
    return {};
  }

  return {
    techniqueCatalog: buildTechniqueCatalog(recipe),
  };
}

function buildRetentionFixerContext(recipe) {
  const retention = mergeShortsRetentionProfile(recipe.shortsRetentionProfile ?? {}, {
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    creativityProfile: recipe.creativityProfile ?? {},
  });

  if (!shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    creativityProfile: recipe.creativityProfile ?? {},
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    return {};
  }

  const durationSec = resolveShortOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });

  return {
    shortsRetentionProfile: retention,
    retentionBeatTargets: computeRetentionBeatTargets(durationSec, retention),
  };
}

export async function runFixer(client, {
  recipe,
  review,
  abstraction,
  topicIndex,
  spatialIndex,
  wordIndexes,
  timelineIndex,
  audioIndex = null,
  perClipAnalysis = null,
}) {
  const promptVersion = resolveFixerPromptVersion(recipe);
  const system = loadPrompt("fixer", { version: promptVersion });
  const retentionContext = recipe.version === "2.2" || recipe.version === "2.3"
    || shouldRunShortsRetentionValidation({
      recipeVersion: recipe.version,
      outputs: recipe.outputs ?? [],
      requiredFormats: recipe.batchContext?.requiredFormats ?? [],
      creativityProfile: recipe.creativityProfile ?? {},
      shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
    })
    ? buildRetentionFixerContext(recipe)
    : {};
  const repairContext = buildRepairContext({
    recipe,
    timelineIndex,
    audioIndex,
    topicIndex,
    spatialIndex,
    wordIndexes,
    perClipAnalysis,
  });
  const creativeContext = buildCreativeFixerContext({
    recipe,
  });
  const fixerContext = {
    ...repairContext,
    ...creativeContext,
    ...retentionContext,
  };

  const user = JSON.stringify({
    recipe,
    issues: review.issues,
    sessionSummary: abstraction.L3,
    ...fixerContext,
  });

  const raw = await chatJson(client, {
    model: MODELS.fixer,
    system,
    user,
    temperature: 0.3,
  });

  raw.batchId = recipe.batchId;
  raw.version = recipe.version ?? "2.0";

  if (raw.version === "2.0" || raw.version === "2.1" || raw.version === "2.2" || raw.version === "2.3") {
    return EditRecipeV2Schema.parse(raw);
  }

  return raw;
}
