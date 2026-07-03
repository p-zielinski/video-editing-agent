import path from "node:path";
import fs from "node:fs";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import { validateRecipeV2, buildSceneUsageRegistryV2 } from "../../validators/recipe-v2.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { loadAudioIndex, loadPerClipAudioAnalysisForCatalog } from "./audio-analysis.js";
import { buildBrollSyncHintsForRecipe } from "../../editorial/broll-sync-hints.js";
import { buildChapterCardHints } from "../../editorial/chapter-hints.js";
import {
  applyDeterministicRecipeEnrichers,
  ensureSpatialIndex,
} from "./agents.js";

function loadClipRegistry(workDir) {
  const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const data = readJson(registryPath);
  return data.clipRegistry ?? data;
}

function loadTopicIndex(workDir) {
  const topicPath = path.join(workDir, ARTIFACTS.topicIndex);
  if (!fs.existsSync(topicPath)) {
    return { topics: [] };
  }
  return readJson(topicPath);
}

function loadSpatialIndex(workDir) {
  const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
  if (!fs.existsSync(spatialPath)) {
    return { scenes: [] };
  }
  return readJson(spatialPath);
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

function resolveRecipeArtifact(source) {
  if (source === "final") {
    return ARTIFACTS.recipeFinal;
  }
  return ARTIFACTS.recipeDraft;
}

/**
 * Re-run deterministic enrichers on an existing recipe without GPT.
 */
export async function runRecipeEnrichStep({
  workDir,
  source = "draft",
  target = "draft",
  force = false,
  faceStub = false,
  batchContext = {},
}) {
  const sourceArtifact = resolveRecipeArtifact(source);
  const sourcePath = path.join(workDir, sourceArtifact);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Brak ${sourceArtifact} — uruchom direct/review lub podaj --source final`);
  }

  let recipe = EditRecipeV2Schema.parse(readJson(sourcePath));
  const timelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const topicIndex = loadTopicIndex(workDir);
  const spatialIndex = await ensureSpatialIndex(workDir, { force, faceStub });
  const audioIndex = loadAudioIndex(workDir);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const wordIndexes = loadWordIndexes(workDir, catalog);
  const keyframeArtifacts = loadKeyframesByClip(workDir, catalog);
  const clipRegistry = resolveClipRegistryForEnrichers(workDir, recipe);
  const requiredFormats = recipe.batchContext?.requiredFormats
    ?? batchContext.requiredFormats
    ?? ["16:9", "9:16"];

  applyDeterministicRecipeEnrichers(recipe, {
    abstraction,
    timelineIndex,
    topicIndex,
    spatialIndex,
    audioIndex,
    clipRegistry,
    perClipAnalysis,
    batchContext: { ...batchContext, ...recipe.batchContext },
    keyframeArtifacts,
    wordIndexes,
  });

  recipe.sceneUsageRegistry = buildSceneUsageRegistryV2(recipe);

  const validation = validateRecipeV2(recipe, {
    requiredFormats,
    topicIndex,
    spatialIndex,
    wordIndexes,
    audioIndex,
    abstraction,
    timelineIndex,
    keyframeArtifacts,
    batchContext: { ...batchContext, ...recipe.batchContext },
    brollSyncHints: buildBrollSyncHintsForRecipe({
      abstraction,
      timelineIndex,
      topicIndex,
      keyframeArtifacts,
      batchContext: { ...batchContext, ...recipe.batchContext },
      recipe,
    }),
    chapterCardHints: buildChapterCardHints(abstraction, {
      outputs: recipe.outputs,
      batchContext: { ...batchContext, ...recipe.batchContext },
    }),
  });

  const targetArtifact = resolveRecipeArtifact(target);
  writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);

  if (target === "final") {
    if (!validation.valid) {
      const errorSummary = validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ");
      const error = new Error(
        `Receptura po enrich nie przeszła walidacji — nie zapisano ${ARTIFACTS.recipeFinal}: ${errorSummary}`,
      );
      error.code = "RECIPE_VALIDATION_FAILED";
      error.validation = validation;
      throw error;
    }
    writeJson(path.join(workDir, ARTIFACTS.recipeFinal), recipe);
  }

  return { recipe, validation, written: targetArtifact };
}
