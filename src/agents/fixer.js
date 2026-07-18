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

/** Keep complete format presets; ignore fixer stubs missing width/height. */
export function mergeRenderStylePresets(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  const formats = { ...(base?.formats ?? {}) };
  for (const key of ["16:9", "9:16"]) {
    const format = override.formats?.[key];
    if (
      format
      && typeof format === "object"
      && Number.isFinite(Number(format.width))
      && Number.isFinite(Number(format.height))
    ) {
      formats[key] = {
        ...(formats[key] ?? {}),
        ...format,
        width: Number(format.width),
        height: Number(format.height),
      };
    }
  }
  const merged = {
    ...(base ?? {}),
    ...override,
  };
  if (Object.keys(formats).length > 0) {
    merged.formats = formats;
  } else {
    delete merged.formats;
  }
  return Object.keys(merged).length > 0 ? merged : base;
}

/** Drop cut stubs missing required wordIds/reason before Zod parse. */
export function sanitizeFixerCuts(outputs) {
  for (const output of outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (!Array.isArray(segment.cuts)) {
        continue;
      }
      segment.cuts = segment.cuts.filter((cut) => (
        cut
        && typeof cut === "object"
        && !Array.isArray(cut)
        && typeof cut.startWordId === "string"
        && cut.startWordId.length > 0
        && typeof cut.endWordId === "string"
        && cut.endWordId.length > 0
        && typeof cut.reason === "string"
      ));
    }
  }
  return outputs;
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
  quotaTracker,
  batchId,
  step,
  superCriticReview = null,
  attempt = 1,
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
    role: attempt > 1 ? "fixerEscalation" : "fixer",
    model: attempt > 1 ? MODELS.fixerEscalation : MODELS.fixer,
    system,
    user,
    temperature: 0.3,
    onUsage,
    quotaTracker,
    batchId,
    step,
  });

  raw.batchId = recipe.batchId;
  raw.version = raw.version ?? recipe.version ?? "2.0";

  const version = String(raw.version ?? "");
  if (version.startsWith("2.")) {
    const rawOutputs = Array.isArray(raw.outputs)
      ? raw.outputs.filter((output) => (
        output
        && typeof output === "object"
        && !Array.isArray(output)
        && typeof output.outputId === "string"
        && (output.format === "16:9" || output.format === "9:16")
        && Array.isArray(output.timeline)
      ))
      : [];
    const merged = {
      ...structuredClone(recipe),
      ...raw,
      batchContext: {
        ...(recipe.batchContext ?? {}),
        ...(raw.batchContext ?? {}),
      },
      // Prefer fixer outputs only when they are structurally complete; otherwise keep draft.
      outputs: rawOutputs.length > 0 ? sanitizeFixerCuts(rawOutputs) : recipe.outputs,
      // Always keep analysis clip registry — fixer drafts often omit required fields.
      clipRegistry: recipe.clipRegistry,
      // Prefer draft mix plan when fixer returns incomplete segment stubs.
      audioMixPlan: (() => {
        const plan = raw.audioMixPlan;
        if (!plan || typeof plan !== "object" || !Array.isArray(plan.segments)) {
          return recipe.audioMixPlan;
        }
        const segments = plan.segments.filter((segment) => (
          segment
          && typeof segment === "object"
          && typeof segment.outputId === "string"
        ));
        return segments.length > 0
          ? { ...plan, segments }
          : recipe.audioMixPlan;
      })(),
      // Drop incomplete format presets from fixer (e.g. 9:16 without width/height).
      renderStylePresets: mergeRenderStylePresets(recipe.renderStylePresets, raw.renderStylePresets),
      creativeMoments: Array.isArray(raw.creativeMoments)
        ? raw.creativeMoments.filter((moment) => moment && typeof moment === "object" && !Array.isArray(moment))
        : (recipe.creativeMoments ?? []),
      sceneUsageRegistry: [],
    };
    const vo = merged.salvagePlan?.voiceOverProposal;
    if (vo && !(Number.isFinite(vo.estimatedDurationSec) && vo.estimatedDurationSec > 0)) {
      delete vo.estimatedDurationSec;
    }
    return EditRecipeV2Schema.parse(merged);
  }

  return raw;
}
