import path from "node:path";
import fs from "node:fs";
import { createOpenAIClient } from "../../agents/openai-client.js";
import { buildAbstractionBundle } from "../../agents/summarizer.js";
import { runDirector, directorDrillDown, extractSceneIdsFromRecipe } from "../../agents/director.js";
import { runCritic } from "../../agents/critic.js";
import { runFixer, shouldInvokeFixer } from "../../agents/fixer.js";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import { validateRecipeV2, buildSceneUsageRegistryV2 } from "../../validators/recipe-v2.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact, isArtifactStale } from "../artifact-deps.js";
import { runSpatialIndexStep } from "./spatial-index.js";
import { loadAudioIndex, loadPerClipAudioAnalysisForCatalog } from "./audio-analysis.js";
import { deriveAudioMixPlanDefaults, mergeAudioMixPlan } from "../../editorial/audio-mix-plan.js";
import { enrichRecipeSfxPlan } from "../../editorial/sfx-plan.js";
import { enrichRecipeChapterCards, buildColdOpenSegmentHint, enrichRecipeColdOpenSegment } from "../../editorial/chapter-hints.js";
import { enrichRecipeRetentionBeats } from "../../editorial/shorts-retention.js";
import {
  buildBrollSyncHintsForRecipe,
  enrichBrollSyncFromHints,
  buildKeyframesByClip,
} from "../../editorial/broll-sync-hints.js";

import { enrichRecipeSilenceBeatFromDeadAir } from "../../editorial/dead-air-enrich.js";
import { refineClipRegistryFromL1 } from "./clip-profile.js";

const MAX_REVIEW_ITERATIONS = 3;

export function applyDeterministicRecipeEnrichers(recipe, {
  abstraction,
  timelineIndex,
  topicIndex,
  spatialIndex,
  audioIndex,
  clipRegistry,
  perClipAnalysis,
  batchContext = {},
  keyframeArtifacts = null,
}) {
  const effectiveBatchContext = {
    ...batchContext,
    ...(recipe.batchContext ?? {}),
  };

  const coldOpenHint = buildColdOpenSegmentHint(
    abstraction,
    {
      outputs: recipe.outputs,
      batchContext: effectiveBatchContext,
    },
    { clipRegistry, timelineIndex },
  );
  enrichRecipeColdOpenSegment(recipe, coldOpenHint, timelineIndex);

  recipe.sfxPlan = enrichRecipeSfxPlan(recipe, {
    audioIndex,
    clipRegistry,
    perClipAnalysis,
  });

  recipe.creativeMoments = enrichRecipeRetentionBeats(recipe, {
    audioIndex,
    abstraction,
    timelineIndex,
    spatialIndex,
  });

  recipe.creativeMoments = enrichRecipeSilenceBeatFromDeadAir(recipe, {
    audioIndex,
    timelineIndex,
  });

  enrichRecipeChapterCards(recipe, { abstraction });

  if (effectiveBatchContext.brollStrategy !== "minimal") {
    const brollSyncHints = buildBrollSyncHintsForRecipe({
      abstraction,
      timelineIndex,
      topicIndex,
      keyframeArtifacts,
      batchContext: effectiveBatchContext,
      recipe,
    });
    enrichBrollSyncFromHints(recipe, brollSyncHints);
  }

  return recipe;
}

function resolveOpenAIClient({ apiKey, openaiClient }) {
  if (openaiClient) {
    return openaiClient;
  }
  return createOpenAIClient(apiKey);
}

export async function runAbstractStep({
  workDir,
  apiKey,
  openaiClient,
  userContext = "",
  force = false,
}) {
  const abstractPath = path.join(workDir, ARTIFACTS.abstraction);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.abstraction, force)) {
    return readJson(abstractPath);
  }

  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const clipRegistry = loadClipRegistry(workDir);
  const client = resolveOpenAIClient({ apiKey, openaiClient });
  const bundle = await buildAbstractionBundle(client, timelineIndex, {
    userContext,
    clipRegistry,
  });

  writeJson(path.join(workDir, ARTIFACTS.abstractionL1), bundle.L1);
  writeJson(path.join(workDir, ARTIFACTS.abstractionL2), bundle.L2);
  writeJson(path.join(workDir, ARTIFACTS.abstractionL3), bundle.L3);
  writeJson(abstractPath, bundle);
  return bundle;
}

function loadClipRegistry(workDir, { abstraction = null, timelineIndex = null } = {}) {
  const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const data = readJson(registryPath);
  const clipRegistry = data.clipRegistry ?? data;
  if (abstraction && timelineIndex) {
    return refineClipRegistryFromL1(clipRegistry, abstraction, timelineIndex);
  }
  return clipRegistry;
}

function loadSpatialIndex(workDir) {
  const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
  if (!fs.existsSync(spatialPath)) {
    return { scenes: [] };
  }
  return readJson(spatialPath);
}

export async function ensureSpatialIndex(workDir, { force = false, faceStub = false } = {}) {
  const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.spatialIndex, force)) {
    return readJson(spatialPath);
  }
  return runSpatialIndexStep({
    workDir,
    force: force || isArtifactStale(workDir, ARTIFACTS.spatialIndex),
    faceStub,
  });
}

function loadTopicIndex(workDir) {
  const topicPath = path.join(workDir, ARTIFACTS.topicIndex);
  if (!fs.existsSync(topicPath)) {
    return { topics: [] };
  }
  return readJson(topicPath);
}

function loadWordIndexes(workDir, catalog) {
  return catalog.clips.map((clip) => {
    try {
      return readJson(path.join(workDir, ARTIFACTS.words(clip.clipId)));
    } catch {
      return { clipId: clip.clipId, words: [] };
    }
  });
}

function loadKeyframesByClip(workDir, catalog) {
  return (catalog?.clips ?? []).map((clip) => {
    const keyframePath = path.join(workDir, ARTIFACTS.keyframes(clip.clipId));
    if (!fs.existsSync(keyframePath)) {
      return { clipId: clip.clipId, keyframes: [] };
    }
    try {
      return readJson(keyframePath);
    } catch {
      return { clipId: clip.clipId, keyframes: [] };
    }
  });
}

function resolveClipRegistryForEnrichers(workDir, recipe) {
  const loaded = loadClipRegistry(workDir);
  if (!loaded.length) {
    return recipe?.clipRegistry ?? [];
  }
  if (!recipe?.clipRegistry?.length) {
    return loaded;
  }
  const byId = new Map(loaded.map((entry) => [entry.clipId, entry]));
  for (const entry of recipe.clipRegistry) {
    byId.set(entry.clipId, { ...byId.get(entry.clipId), ...entry });
  }
  return [...byId.values()];
}

function buildRecipeValidationOptions({
  recipe,
  requiredFormats,
  topicIndex,
  spatialIndex,
  wordIndexes,
  audioIndex,
  abstraction,
  timelineIndex,
  keyframeArtifacts,
  batchContext,
}) {
  return {
    requiredFormats,
    topicIndex,
    spatialIndex,
    wordIndexes,
    audioIndex,
    brollSyncHints: buildBrollSyncHintsForRecipe({
      abstraction,
      timelineIndex,
      topicIndex,
      keyframeArtifacts,
      batchContext,
      recipe,
    }),
  };
}

export async function runDirectStep({
  workDir,
  apiKey,
  openaiClient,
  requiredFormats = ["16:9", "9:16"],
  userContext = "",
  batchContext = {},
  force = false,
  faceStub = false,
}) {
  const draftPath = path.join(workDir, ARTIFACTS.recipeDraft);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.recipeDraft, force)) {
    return readJson(draftPath);
  }

  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const clipRegistry = loadClipRegistry(workDir, { abstraction, timelineIndex });
  const topicIndex = loadTopicIndex(workDir);
  const spatialIndex = await ensureSpatialIndex(workDir, { force, faceStub });
  const audioIndex = loadAudioIndex(workDir);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const wordIndexes = loadWordIndexes(workDir, catalog);
  const keyframeArtifacts = loadKeyframesByClip(workDir, catalog);
  const keyframesByClip = buildKeyframesByClip(timelineIndex, keyframeArtifacts);
  const client = resolveOpenAIClient({ apiKey, openaiClient });

  const audioMixDefaults = deriveAudioMixPlanDefaults({
    audioIndex,
    outputs: [],
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
  });

  const context = {
    abstraction,
    timelineIndex,
    clipRegistry,
    topicIndex,
    spatialIndex,
    audioIndex,
    audioMixDefaults,
    perClipAnalysis,
    wordIndexes,
    keyframesByClip,
    userContext,
    requiredFormats,
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
  };

  let recipe = await runDirector(client, context);

  const sceneIds = extractSceneIdsFromRecipe(recipe);
  if (sceneIds.length > 0) {
    recipe = await directorDrillDown(client, {
      ...context,
      recipe,
      sceneIds,
    });
  }

  recipe.audioMixPlan = mergeAudioMixPlan(recipe, deriveAudioMixPlanDefaults({
    audioIndex,
    outputs: recipe.outputs,
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
  }));

  applyDeterministicRecipeEnrichers(recipe, {
    abstraction,
    timelineIndex,
    topicIndex,
    spatialIndex,
    audioIndex,
    clipRegistry,
    perClipAnalysis,
    batchContext,
    keyframeArtifacts,
  });

  recipe.sceneUsageRegistry = buildSceneUsageRegistryV2(recipe);
  writeJson(draftPath, recipe);
  return recipe;
}

export async function runReviewStep({
  workDir,
  apiKey,
  openaiClient,
  requiredFormats = ["16:9", "9:16"],
  batchContext = {},
  maxIterations = MAX_REVIEW_ITERATIONS,
  force = false,
  faceStub = false,
}) {
  const finalPath = path.join(workDir, ARTIFACTS.recipeFinal);
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const topicIndex = loadTopicIndex(workDir);
  const spatialIndex = await ensureSpatialIndex(workDir, { force, faceStub });
  const audioIndex = loadAudioIndex(workDir);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const wordIndexes = loadWordIndexes(workDir, catalog);
  const keyframeArtifacts = loadKeyframesByClip(workDir, catalog);

  if (shouldUseCachedArtifact(workDir, ARTIFACTS.recipeFinal, force)) {
    const recipe = EditRecipeV2Schema.parse(readJson(finalPath));
    const validation = validateRecipeV2(recipe, buildRecipeValidationOptions({
      recipe,
      requiredFormats,
      topicIndex,
      spatialIndex,
      wordIndexes,
      audioIndex,
      abstraction: readJson(path.join(workDir, ARTIFACTS.abstraction)),
      timelineIndex: readJson(path.join(workDir, ARTIFACTS.timelineIndex)),
      keyframeArtifacts,
      batchContext,
    }));
    if (validation.valid) {
      const reviewPath = path.join(workDir, ARTIFACTS.review);
      const review = fs.existsSync(reviewPath) ? readJson(reviewPath) : null;
      return { recipe, review, validation, finalWritten: false, skipped: true };
    }
  }

  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const client = resolveOpenAIClient({ apiKey, openaiClient });

  let recipe = EditRecipeV2Schema.parse(
    readJson(path.join(workDir, ARTIFACTS.recipeDraft)),
  );

  let iteration = 0;
  let lastReview = null;
  const validationBase = {
    requiredFormats,
    topicIndex,
    spatialIndex,
    wordIndexes,
    audioIndex,
    abstraction,
    timelineIndex,
    keyframeArtifacts,
    batchContext,
  };

  while (iteration < maxIterations) {
    iteration += 1;
    const brollSyncHints = buildBrollSyncHintsForRecipe({
      abstraction,
      timelineIndex,
      topicIndex,
      keyframeArtifacts,
      batchContext,
      recipe,
    });
    lastReview = await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      topicIndex,
      spatialIndex,
      iteration,
      requiredFormats,
      wordIndexes,
      audioIndex,
      perClipAnalysis,
      brollSyncHints,
    });

    writeJson(path.join(workDir, ARTIFACTS.review), lastReview);

    if (lastReview.approved) {
      break;
    }

    if (!shouldInvokeFixer(lastReview.issues)) {
      break;
    }

    recipe = EditRecipeV2Schema.parse(
      await runFixer(client, {
        recipe,
        review: lastReview,
        abstraction,
        topicIndex,
        spatialIndex,
        wordIndexes,
        timelineIndex,
        audioIndex,
        perClipAnalysis,
        brollSyncHints,
      }),
    );
    applyDeterministicRecipeEnrichers(recipe, {
      abstraction,
      timelineIndex,
      topicIndex,
      spatialIndex,
      audioIndex,
      clipRegistry: resolveClipRegistryForEnrichers(workDir, recipe),
      perClipAnalysis,
      batchContext,
      keyframeArtifacts: loadKeyframesByClip(workDir, catalog),
    });
    recipe.sceneUsageRegistry = buildSceneUsageRegistryV2(recipe);
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
  }

  const validation = validateRecipeV2(recipe, buildRecipeValidationOptions({
    recipe,
    ...validationBase,
  }));
  recipe.sceneUsageRegistry = buildSceneUsageRegistryV2(recipe);
  recipe.needsHumanReview = !lastReview?.approved || !validation.valid;
  if (recipe.needsHumanReview && lastReview?.summary) {
    recipe.reviewNotes = lastReview.summary;
  }

  writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);

  if (!validation.valid) {
    const errorSummary = validation.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    const error = new Error(
      `Receptura nie przeszła walidacji — nie zapisano ${ARTIFACTS.recipeFinal}: ${errorSummary}`,
    );
    error.code = "RECIPE_VALIDATION_FAILED";
    error.validation = validation;
    error.review = lastReview;
    throw error;
  }

  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);

  return { recipe, review: lastReview, validation, finalWritten: true };
}
