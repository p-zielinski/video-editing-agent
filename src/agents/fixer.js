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
  mergeVlogRetentionProfile,
  resolveMainOutputDurationSec,
  resolveShortOutputDurationSec,
  shouldRunShortsRetentionValidation,
  shouldRunVlogRetentionValidation,
} from "../editorial/shorts-retention.js";
import {
  buildEditorialContext,
  spreadEditorialToPayload,
} from "../editorial/editorial-context.js";
import { chatJson, loadPrompt, MODELS } from "./openai-client.js";

/** V22-VLOG warnings the fixer should attempt to repair (not only errors). */
export const FIXABLE_VLOG_WARNING_CODES = new Set([
  "V22-VLOG-03",
  "V22-VLOG-04",
  "V22-VLOG-05",
]);

/** V24 warnings the fixer should attempt to repair. */
export const FIXABLE_V24_WARNING_CODES = new Set([
  "V24-05",
]);

/** V25 warnings the fixer should attempt to repair. */
export const FIXABLE_V25_WARNING_CODES = new Set([
  "V25-BROLL-04",
  "V25-BROLL-05",
  "V25-BROLL-06",
  "V25-CHR-03",
]);

/** V26 warnings the fixer should attempt to repair. */
export const FIXABLE_V26_WARNING_CODES = new Set([
  "V26-FILLER-01",
  "V26-DEADAIR-01",
  "V26-CTA-01",
  "V26-CHAPTER-01",
]);

/** NAR-* narrative warnings the fixer should attempt to repair. */
export const FIXABLE_NAR_WARNING_CODES = new Set([
  "NAR-BEAT-SPAM",
  "NAR-BREATH-BEAT",
  "NAR-CLOSURE-SPAM",
  "NAR-CALLBACK-UNDELIVERED",
  "NAR-PAYOFF-UNDELIVERED",
  "NAR-PAYOFF-MISSING",
  "NAR-DRAMATIC-PAUSE-CUT",
]);

export function isNarrativeIssueCode(code) {
  return typeof code === "string" && code.startsWith("NAR-");
}

export function extractNarrativeIssues(issues = []) {
  return issues.filter((issue) => isNarrativeIssueCode(issue.code));
}

export function shouldInvokeFixer(issues = []) {
  if (issues.some((issue) => issue.severity === "error")) {
    return true;
  }
  return issues.some(
    (issue) => issue.severity === "warning"
      && (FIXABLE_VLOG_WARNING_CODES.has(issue.code)
        || FIXABLE_V24_WARNING_CODES.has(issue.code)
        || FIXABLE_V25_WARNING_CODES.has(issue.code)
        || FIXABLE_V26_WARNING_CODES.has(issue.code)
        || FIXABLE_NAR_WARNING_CODES.has(issue.code)),
  );
}

export function resolveFixerPromptVersion(recipe) {
  const version = recipe?.version;
  if (typeof version === "string" && /^2\.\d+$/.test(version)) {
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

export function recipeHasCreativeLayer(recipe) {
  const version = parseFloat(recipe?.version);
  if (Number.isFinite(version) && version >= 2.1) {
    return true;
  }
  return (recipe?.creativeMoments?.length ?? 0) > 0;
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
  const hasCreativeLayer = recipeHasCreativeLayer(recipe);

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
  if (!recipeHasCreativeLayer(recipe)) {
    return {};
  }

  return {
    techniqueCatalog: buildTechniqueCatalog(recipe),
  };
}

function buildRetentionFixerContext(recipe) {
  const requiredFormats = recipe.batchContext?.requiredFormats ?? [];
  const context = {};

  if (shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    creativityProfile: recipe.creativityProfile ?? {},
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })) {
    const retention = mergeShortsRetentionProfile(recipe.shortsRetentionProfile ?? {}, {
      outputs: recipe.outputs ?? [],
      requiredFormats,
      creativityProfile: recipe.creativityProfile ?? {},
    });
    const durationSec = resolveShortOutputDurationSec({
      outputs: recipe.outputs ?? [],
      batchContext: recipe.batchContext ?? {},
    });
    context.shortsRetentionProfile = retention;
    context.retentionBeatTargets = computeRetentionBeatTargets(durationSec, retention);
  }

  if (shouldRunVlogRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats,
    vlogRetentionProfile: recipe.vlogRetentionProfile ?? {},
  })) {
    const vlogRetention = mergeVlogRetentionProfile(recipe.vlogRetentionProfile ?? {}, {
      outputs: recipe.outputs ?? [],
      requiredFormats,
    });
    const durationSec = resolveMainOutputDurationSec({
      outputs: recipe.outputs ?? [],
      batchContext: recipe.batchContext ?? {},
    });
    context.vlogRetentionProfile = vlogRetention;
    context.retentionBeatTargetsMain = computeRetentionBeatTargets(
      durationSec,
      vlogRetention,
      { mode: "vlog" },
    );
  }

  return context;
}

function buildNarrativeFixerContext({ recipe, sessionSummary, issues }) {
  const narrativeIssues = extractNarrativeIssues(issues);
  if (narrativeIssues.length === 0) {
    return {};
  }

  const context = { narrativeIssues };
  const openLoops = sessionSummary?.openLoops;
  if (openLoops?.length) {
    context.openLoops = openLoops;
  }
  const narrativeProfile = recipe.narrativeProfile ?? sessionSummary?.narrativeProfile;
  if (narrativeProfile) {
    context.narrativeProfile = narrativeProfile;
  }
  return context;
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
  brollSyncHints = null,
  onUsage,
  superCriticReview = null,
}) {
  const promptVersion = resolveFixerPromptVersion(recipe);
  const system = loadPrompt("fixer", { version: promptVersion });
  const retentionContext = shouldRunShortsRetentionValidation({
    recipeVersion: recipe.version,
    outputs: recipe.outputs ?? [],
    requiredFormats: recipe.batchContext?.requiredFormats ?? [],
    creativityProfile: recipe.creativityProfile ?? {},
    shortsRetentionProfile: recipe.shortsRetentionProfile ?? {},
  })
    || shouldRunVlogRetentionValidation({
      recipeVersion: recipe.version,
      outputs: recipe.outputs ?? [],
      requiredFormats: recipe.batchContext?.requiredFormats ?? [],
      vlogRetentionProfile: recipe.vlogRetentionProfile ?? {},
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
    ...(brollSyncHints?.length ? { brollSyncHints } : {}),
  };

  const narrativeContext = buildNarrativeFixerContext({
    recipe,
    sessionSummary: abstraction.L3,
    issues: review.issues,
  });
  const user = JSON.stringify({
    recipe,
    issues: review.issues,
    ...narrativeContext,
    sessionSummary: abstraction.L3,
    ...fixerContext,
    ...(superCriticReview?.crossSegmentNotes?.length
      ? { priorCrossSegmentReview: superCriticReview.crossSegmentNotes }
      : {}),
  });

  const raw = await chatJson(client, {
    model: MODELS.fixer,
    system,
    user,
    temperature: 0.3,
    onUsage,
  });

  raw.batchId = recipe.batchId;
  raw.version = raw.version ?? recipe.version ?? "2.0";

  const version = raw.version;
  if (version === "2.0" || version === "2.1" || version === "2.2" || version === "2.3" || version === "2.4") {
    const merged = {
      ...structuredClone(recipe),
      ...raw,
      batchContext: {
        ...(recipe.batchContext ?? {}),
        ...(raw.batchContext ?? {}),
      },
      outputs: raw.outputs ?? recipe.outputs,
      clipRegistry: raw.clipRegistry ?? recipe.clipRegistry,
      creativeMoments: raw.creativeMoments ?? recipe.creativeMoments,
    };
    return EditRecipeV2Schema.parse(merged);
  }

  return raw;
}
