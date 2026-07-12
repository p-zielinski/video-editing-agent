import path from "node:path";
import fs from "node:fs";
import { createOpenAIClient } from "../../agents/openai-client.js";
import { buildAbstractionBundle } from "../../agents/summarizer.js";
import {
  runDirector,
  directorDrillDown,
  extractSceneIdsFromRecipe,
  attachRetentionBeatTargets,
  shouldRunDirectorDrillDown,
} from "../../agents/director.js";
import { runSuperDirector } from "../../agents/super-director.js";
import { runSegmentDirector } from "../../agents/segment-director.js";
import {
  buildSegmentCatalog,
  resolveSegmentPicks,
  shouldUseSuperDirector,
} from "../../lib/segment-catalog.js";
import { mergeSegmentRecipes } from "../../lib/recipe-merge.js";
import { resolveEffectiveNarrativeProfile } from "../../lib/narrative-profile.js";
import { buildEmotionalBeatHints } from "../../agents/director.js";
import { validateStitchContinuity } from "../../validators/stitch-continuity.js";
import { repairStitchContinuity } from "../../lib/stitch-repair.js";
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
import { enrichRecipeChapterCards, buildChapterCardHints, buildColdOpenSegmentHint, enrichRecipeColdOpenSegment } from "../../editorial/chapter-hints.js";
import { enrichRecipeRetentionBeats, stripEnrichBeatsInSlowSegments } from "../../editorial/shorts-retention.js";
import { enrichRecipeActTransitions } from "../../editorial/act-transitions.js";
import {
  buildBrollSyncHintsForRecipe,
  enrichBrollSyncFromHints,
  buildKeyframesByClip,
} from "../../editorial/broll-sync-hints.js";

import { enrichRecipeDeadAirHandling } from "../../editorial/dead-air-enrich.js";
import { enrichRecipeFillerCuts } from "../../editorial/filler-enrich.js";
import { enrichRecipeProfanity } from "../../editorial/profanity-enrich.js";
import { enrichRecipeBrandSafetyText } from "../../editorial/brand-safety-enrich.js";
import { enrichRecipeVoiceDirectives } from "../../editorial/voice-directive-enrich.js";
import { enrichRecipePacingTrim } from "../../editorial/pacing-enrich.js";
import { enrichRecipeFastRhythmSpeed } from "../../editorial/speed-enrich.js";
import { enrichRecipePayoffMoments } from "../../editorial/payoff-enrich.js";
import { enrichRecipeCallbackMoments } from "../../editorial/callback-enrich.js";
import { enrichRecipeClosureCta } from "../../editorial/closure-enrich.js";
import { enrichRecipeShortsOutroBracket } from "../../editorial/shorts-outro-bracket.js";
import { enrichRecipeJlCutSnap } from "../../editorial/jlcut-snap.js";
import { enrichRecipeAiHook, loadAiVideoArtifact } from "../../editorial/ai-hook-enrich.js";
import { enrichRecipeShortIntroSkip } from "../../editorial/shorts-intro-skip.js";
import { enrichRecipeMusicBeatSnap } from "../../editorial/music-beat-snap.js";
import { enrichRecipeDisableColorGrade } from "../../editorial/color-grade-policy.js";
import { resolveMusicBeatGridForBrief } from "../../lib/music-beat-grid.js";
import { runMusicCurator } from "../../agents/music-curator.js";
import { enrichUnpickedL2Bridges } from "../../editorial/bridge-enrich.js";
import { enrichJumpCutsAsTimeCuts } from "../../render/time-cuts.js";
import { runSuperCritic } from "../../agents/super-critic.js";
import { refineClipRegistryFromL1 } from "./clip-profile.js";
import {
  snapshotRecipeStage,
  createEnricherAuditWrapper,
  buildProvenanceDocument,
  writeRecipeProvenance,
  readRecipeProvenance,
  stripRecipeProvenanceFields,
} from "../../lib/recipe-provenance.js";
import { createUsageRecorder } from "../../lib/gpt-usage-log.js";
import { mapWithConcurrency } from "../../lib/map-with-concurrency.js";
import { createBriefMetricsAccumulator } from "../../lib/brief-metrics.js";

const MAX_REVIEW_ITERATIONS = 3;

function parseSegmentDirectorConcurrency() {
  const raw = process.env.SEGMENT_DIRECTOR_CONCURRENCY;
  if (raw === undefined || raw === "") {
    return 3;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 3;
}

export const SEGMENT_DIRECTOR_CONCURRENCY = parseSegmentDirectorConcurrency();

function buildDrillDownOptions(context) {
  return {
    metaCommandsByClip: context.metaCommandsByClip,
    timelineIndex: context.timelineIndex,
    audioIndex: context.audioIndex,
  };
}

function reconstructSuperPlanFromRecipe(recipe, abstraction) {
  const segmentOrder = abstraction?.L2?.map((entry) => entry.segmentId).filter(Boolean) ?? [];
  const segmentPicks = (recipe.narrativeProfile?.segments ?? abstraction?.L2 ?? [])
    .map((entry) => ({
      segmentId: entry.l2SegmentId ?? entry.segmentId,
      ...entry,
    }))
    .filter((pick) => pick.segmentId);

  return {
    segmentOrder,
    segmentPicks,
    crossSegmentNotes: recipe.superPlanNotes ?? [],
    crossSegmentCallbacks: recipe.structuredCallbacks ?? [],
    globalTheme: recipe.batchContext?.theme,
    creativityProfile: recipe.creativityProfile,
    narrativeProfile: recipe.narrativeProfile,
  };
}

export { shouldUseSuperDirector, shouldRunDirectorDrillDown };

function finalizeDirectorMetrics(directorMetrics, briefMetricsAcc) {
  return {
    ...directorMetrics,
    briefMetrics: briefMetricsAcc.finalize(),
  };
}

export async function runSuperDirectorDirectPath(client, context) {
  const {
    abstraction,
    timelineIndex,
    clipRegistry,
    userContext,
    batchContext,
    requiredFormats,
    gptUsageTracker,
  } = context;

  const catalog = buildSegmentCatalog(abstraction, timelineIndex, clipRegistry);
  const briefMetricsAcc = createBriefMetricsAccumulator();
  const superDirectorResult = await runSuperDirector(client, {
    abstraction,
    timelineIndex,
    clipRegistry,
    userContext,
    batchContext,
    requiredFormats,
    aiVideoArtifact: context.aiVideoArtifact,
    onUsage: createUsageRecorder(gptUsageTracker, "super_director"),
  });
  const superPlan = superDirectorResult.plan;
  briefMetricsAcc.record(superDirectorResult.briefMetric);

  const picks = resolveSegmentPicks(superPlan, catalog, batchContext);
  if (picks.length === 0) {
    throw new Error("Super Director nie wybrał żadnego segmentu L2");
  }

  const concurrency = parseSegmentDirectorConcurrency();
  const partials = await mapWithConcurrency(
    picks,
    concurrency,
    async (pick) => {
      const segmentResult = await runSegmentDirector(client, context, {
        segmentId: pick.segmentId,
        sceneIds: pick.catalogCard.sceneIds,
        superPlan,
        superNotes: superPlan.crossSegmentNotes ?? [],
        onUsage: createUsageRecorder(gptUsageTracker, "segment_director"),
      });
      briefMetricsAcc.record(segmentResult.briefMetric);
      return segmentResult.recipe;
    },
  );

  let recipe = mergeSegmentRecipes(superPlan, partials, { wordIndexes: context.wordIndexes });
  enrichUnpickedL2Bridges(recipe, { abstraction, superPlan });
  attachRetentionBeatTargets(recipe, {
    requiredFormats,
    batchContext: context.batchContext,
    timelineIndex,
  });

  let directorMetrics = {
    drillDownRan: false,
    drillDownSceneCount: 0,
    briefSceneMapCoverage: null,
  };

  const sceneIds = extractSceneIdsFromRecipe(recipe);
  if (sceneIds.length > 0 && shouldRunDirectorDrillDown(recipe, batchContext, buildDrillDownOptions(context))) {
    const drillDownResult = await directorDrillDown(client, {
      ...context,
      recipe,
      sceneIds,
      onUsage: createUsageRecorder(gptUsageTracker, "drill_down"),
    });
    recipe = drillDownResult.recipe;
    directorMetrics = drillDownResult.directorMetrics;
    briefMetricsAcc.record(drillDownResult.directorMetrics?.briefMetric);
  }

  const stitchIssues = validateStitchContinuity(recipe, {
    superPlan,
    abstraction,
    partials,
    wordIndexes: context.wordIndexes,
  });
  recipe.stitchValidation = {
    valid: stitchIssues.filter((issue) => issue.severity === "error").length === 0,
    issues: stitchIssues,
  };

  const stitchErrors = stitchIssues.filter((issue) => issue.severity === "error");
  if (stitchErrors.length > 0) {
    const repairResult = repairStitchContinuity(recipe, {
      superPlan,
      abstraction,
      partials,
      wordIndexes: context.wordIndexes,
      timelineIndex: context.timelineIndex,
    });

    if (!repairResult.unfixable) {
      const repairedIssues = validateStitchContinuity(recipe, {
        superPlan,
        abstraction,
        partials,
        wordIndexes: context.wordIndexes,
      });
      recipe.stitchValidation = {
        valid: repairedIssues.filter((issue) => issue.severity === "error").length === 0,
        issues: repairedIssues,
        repaired: repairResult.repaired,
      };
    }

    const remainingErrors = (recipe.stitchValidation?.issues ?? stitchIssues)
      .filter((issue) => issue.severity === "error");
    if (remainingErrors.length > 0) {
      const error = new Error(
        `Scalona receptura nie przeszła walidacji stitch: ${remainingErrors.map((issue) => issue.message).join("; ")}`,
      );
      error.code = "STITCH_VALIDATION_FAILED";
      error.validation = recipe.stitchValidation;
      throw error;
    }
  }

  const superCritic = await runSuperCritic(client, {
    recipe,
    superPlan,
    abstraction,
    partials,
    timelineIndex: context.timelineIndex,
    topicIndex: context.topicIndex,
    spatialIndex: context.spatialIndex,
    audioIndex: context.audioIndex,
    perClipAnalysis: context.perClipAnalysis,
    wordIndexes: context.wordIndexes,
    onUsage: createUsageRecorder(gptUsageTracker, "super_critic"),
  });
  recipe.superCriticReview = superCritic;
  if (superCritic.crossSegmentNotes?.length) {
    recipe.superPlanNotes = [
      ...(recipe.superPlanNotes ?? []),
      ...superCritic.crossSegmentNotes,
    ];
  }

  return {
    recipe,
    directorMetrics: finalizeDirectorMetrics({
      ...directorMetrics,
      directorPath: "super",
    }, briefMetricsAcc),
  };
}

function buildDeterministicEnricherSteps(recipe, {
  abstraction,
  timelineIndex,
  topicIndex,
  spatialIndex,
  audioIndex,
  clipRegistry,
  perClipAnalysis,
  batchContext = {},
  keyframeArtifacts = null,
  wordIndexes = null,
  metaCommandsByClip = null,
  aiVideoArtifact = null,
  musicBeatGrid = null,
}) {
  const effectiveBatchContext = {
    ...batchContext,
    ...(recipe.batchContext ?? {}),
  };

  const emotionalBeatHints = buildEmotionalBeatHints(abstraction, timelineIndex);

  return [
    {
      name: "stripEnrichBeatsInSlowSegments",
      apply: () => {
        recipe.creativeMoments = stripEnrichBeatsInSlowSegments(recipe, abstraction, { wordIndexes });
      },
    },
    {
      name: "enrichRecipeColdOpenSegment",
      apply: () => {
        const coldOpenHint = buildColdOpenSegmentHint(
          abstraction,
          {
            outputs: recipe.outputs,
            batchContext: effectiveBatchContext,
          },
          { clipRegistry, timelineIndex },
        );
        enrichRecipeColdOpenSegment(recipe, coldOpenHint, timelineIndex);
      },
    },
    {
      name: "enrichRecipeAiHook",
      apply: () => {
        if (aiVideoArtifact) {
          enrichRecipeAiHook(recipe, aiVideoArtifact);
        }
      },
    },
    {
      name: "enrichRecipeShortIntroSkip",
      apply: () => {
        enrichRecipeShortIntroSkip(recipe, {
          abstraction,
          timelineIndex,
          audioIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeFillerCuts",
      apply: () => {
        enrichRecipeFillerCuts(recipe, {
          abstraction,
          timelineIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeProfanity",
      apply: () => {
        enrichRecipeProfanity(recipe, wordIndexes, effectiveBatchContext);
      },
    },
    {
      name: "enrichRecipeVoiceDirectives",
      apply: () => {
        enrichRecipeVoiceDirectives(recipe, metaCommandsByClip ?? [], timelineIndex);
      },
    },
    {
      name: "enrichRecipeDeadAirHandling",
      apply: () => {
        recipe.creativeMoments = enrichRecipeDeadAirHandling(recipe, {
          audioIndex,
          timelineIndex,
          wordIndexes,
          perClipAnalysis,
          abstraction,
        });
      },
    },
    {
      name: "enrichRecipePacingTrim",
      apply: () => {
        enrichRecipePacingTrim(recipe, {
          abstraction,
          timelineIndex,
          wordIndexes,
          estimatedKeepRatio: abstraction?.L3?.estimatedKeepRatio,
          audioIndex,
          perClipAnalysis,
        });
      },
    },
    {
      name: "enrichRecipeFastRhythmSpeed",
      apply: () => {
        enrichRecipeFastRhythmSpeed(recipe, {
          abstraction,
          timelineIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeJlCutSnap",
      apply: () => {
        enrichRecipeJlCutSnap(recipe, wordIndexes);
      },
    },
    {
      name: "enrichRecipeSfxPlan",
      apply: () => {
        recipe.sfxPlan = enrichRecipeSfxPlan(recipe, {
          audioIndex,
          clipRegistry,
          perClipAnalysis,
          wordIndexes,
          abstraction,
          timelineIndex,
        });
      },
    },
    {
      name: "enrichRecipeRetentionBeats",
      apply: () => {
        recipe.creativeMoments = enrichRecipeRetentionBeats(recipe, {
          audioIndex,
          abstraction,
          timelineIndex,
          spatialIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipePayoffMoments",
      apply: () => {
        recipe.creativeMoments = enrichRecipePayoffMoments(recipe, {
          abstraction,
          timelineIndex,
          wordIndexes,
          audioIndex,
          emotionalBeatHints,
        });
      },
    },
    {
      name: "enrichRecipeCallbackMoments",
      apply: () => {
        recipe.creativeMoments = enrichRecipeCallbackMoments(recipe, {
          abstraction,
          timelineIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeClosureCta",
      apply: () => {
        enrichRecipeClosureCta(recipe, { abstraction });
      },
    },
    {
      name: "enrichRecipeShortsOutroBracket",
      apply: () => {
        enrichRecipeShortsOutroBracket(recipe, {
          abstraction,
          timelineIndex,
          audioIndex,
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeChapterCards",
      apply: () => {
        enrichRecipeChapterCards(recipe, { abstraction });
      },
    },
    {
      name: "enrichRecipeActTransitions",
      apply: () => {
        recipe.creativeMoments = enrichRecipeActTransitions(recipe, {
          abstraction,
          narrativeProfile: resolveEffectiveNarrativeProfile({
            recipe,
            batchContext: effectiveBatchContext,
            abstraction,
          }),
          wordIndexes,
        });
      },
    },
    {
      name: "enrichRecipeMusicBeatSnap",
      apply: () => {
        if (musicBeatGrid) {
          recipe.musicBeatGrid = musicBeatGrid;
          enrichRecipeMusicBeatSnap(recipe, { musicBeatGrid });
        }
      },
    },
    {
      name: "enrichBrollSyncFromHints",
      apply: () => {
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
      },
    },
    {
      name: "enrichJumpCutsAsTimeCuts",
      apply: () => {
        enrichJumpCutsAsTimeCuts(recipe);
      },
    },
    {
      name: "enrichRecipeBrandSafetyText",
      apply: () => {
        enrichRecipeBrandSafetyText(recipe, effectiveBatchContext);
      },
    },
    {
      name: "enrichRecipeDisableColorGrade",
      apply: () => {
        enrichRecipeDisableColorGrade(recipe, effectiveBatchContext);
      },
    },
  ];
}

const applyDeterministicRecipeEnrichersWithAudit = createEnricherAuditWrapper(
  buildDeterministicEnricherSteps,
);

export function getDeterministicEnricherStepOrder(context = {}) {
  const recipe = { outputs: [], creativeMoments: [], batchContext: {} };
  return buildDeterministicEnricherSteps(recipe, context).map((step) => step.name);
}

export function applyDeterministicRecipeEnrichers(recipe, context) {
  for (const step of buildDeterministicEnricherSteps(recipe, context)) {
    step.apply();
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
  gptUsageTracker,
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
    onUsage: createUsageRecorder(gptUsageTracker, "abstract"),
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

export async function ensureSpatialIndex(
  workDir,
  { force = false, faceStub = false, globalCacheDisabled = false } = {},
) {
  const spatialPath = path.join(workDir, ARTIFACTS.spatialIndex);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.spatialIndex, force)) {
    return readJson(spatialPath);
  }
  return runSpatialIndexStep({
    workDir,
    force: force || isArtifactStale(workDir, ARTIFACTS.spatialIndex),
    faceStub,
    globalCacheDisabled,
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

export function loadMetaCommandsByClip(workDir, catalog) {
  return catalog.clips.map((clip) => {
    try {
      return readJson(path.join(workDir, ARTIFACTS.metaCommands(clip.clipId)));
    } catch {
      return { clipId: clip.clipId, commands: [] };
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
  perClipAnalysis,
  keyframeArtifacts,
  batchContext,
}) {
  const mergedBatchContext = { ...batchContext, ...recipe.batchContext };
  return {
    requiredFormats,
    topicIndex,
    spatialIndex,
    wordIndexes,
    audioIndex,
    abstraction,
    timelineIndex,
    perClipAnalysis,
    estimatedKeepRatio: abstraction?.L3?.estimatedKeepRatio,
    brollSyncHints: buildBrollSyncHintsForRecipe({
      abstraction,
      timelineIndex,
      topicIndex,
      keyframeArtifacts,
      batchContext: mergedBatchContext,
      recipe,
    }),
    chapterCardHints: abstraction
      ? buildChapterCardHints(abstraction, {
        outputs: recipe.outputs,
        batchContext: mergedBatchContext,
      })
      : (recipe.chapterCardHints ?? []),
  };
}

export function mergeGeneratedAiSceneIntoTimeline(
  timelineIndex,
  sceneCatalog,
  aiVideoArtifact,
) {
  if (aiVideoArtifact?.status !== "succeeded") {
    return timelineIndex;
  }
  const generatedScene = (sceneCatalog?.scenes ?? []).find(
    (scene) => scene.sceneId === aiVideoArtifact.sceneId,
  );
  if (!generatedScene) {
    return timelineIndex;
  }

  const merged = structuredClone(timelineIndex);
  if (!(merged.scenes ?? []).some((scene) => scene.sceneId === generatedScene.sceneId)) {
    merged.scenes = [...(merged.scenes ?? []), structuredClone(generatedScene)];
  }
  const generatedClip = (sceneCatalog?.clips ?? []).find(
    (clip) => clip.clipId === aiVideoArtifact.clipId,
  );
  if (generatedClip && !(merged.clips ?? []).some((clip) => clip.clipId === generatedClip.clipId)) {
    merged.clips = [...(merged.clips ?? []), structuredClone(generatedClip)];
  }
  merged.stats = {
    ...(merged.stats ?? {}),
    totalScenes: merged.scenes.length,
    totalClips: merged.clips?.length ?? 0,
  };
  return merged;
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
  globalCacheDisabled = false,
  gptUsageTracker,
}) {
  const draftPath = path.join(workDir, ARTIFACTS.recipeDraft);
  if (shouldUseCachedArtifact(workDir, ARTIFACTS.recipeDraft, force)) {
    return readJson(draftPath);
  }

  const storedTimelineIndex = readJson(path.join(workDir, ARTIFACTS.timelineIndex));
  const abstraction = readJson(path.join(workDir, ARTIFACTS.abstraction));
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const aiVideoArtifact = loadAiVideoArtifact(workDir);
  const timelineIndex = mergeGeneratedAiSceneIntoTimeline(
    storedTimelineIndex,
    catalog,
    aiVideoArtifact,
  );
  const clipRegistry = loadClipRegistry(workDir, { abstraction, timelineIndex });
  const topicIndex = loadTopicIndex(workDir);
  const spatialIndex = await ensureSpatialIndex(workDir, { force, faceStub, globalCacheDisabled });
  const audioIndex = loadAudioIndex(workDir);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const wordIndexes = loadWordIndexes(workDir, catalog);
  const metaCommandsByClip = loadMetaCommandsByClip(workDir, catalog);
  const keyframeArtifacts = loadKeyframesByClip(workDir, catalog);
  const keyframesByClip = buildKeyframesByClip(timelineIndex, keyframeArtifacts);
  const client = resolveOpenAIClient({ apiKey, openaiClient });

  const curatorResult = await runMusicCurator(client, {
    abstraction,
    audioIndex,
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    requiredFormats,
    userContext,
    onUsage: createUsageRecorder(gptUsageTracker, "music_curator"),
  });
  const musicSelection = curatorResult.musicSelection;
  writeJson(path.join(workDir, ARTIFACTS.musicSelection), {
    version: "1.0",
    ...curatorResult,
    selectedAt: new Date().toISOString(),
  });

  const audioMixDefaults = deriveAudioMixPlanDefaults({
    audioIndex,
    outputs: [],
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    musicSelection,
  });

  const musicBeatGrid = await resolveMusicBeatGridForBrief({
    batchContext: {
      ...batchContext,
      requiredFormats,
      musicBedTrackId: musicSelection?.trackId,
    },
    audioMixDefaults,
    audioIndex,
    musicSelection,
  });

  const context = {
    abstraction,
    timelineIndex,
    clipRegistry,
    topicIndex,
    spatialIndex,
    audioIndex,
    audioMixDefaults,
    musicSelection,
    musicBeatGrid,
    perClipAnalysis,
    wordIndexes,
    metaCommandsByClip,
    keyframesByClip,
    userContext,
    requiredFormats,
    workDir,
    aiVideoArtifact,
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    gptUsageTracker,
  };

  let recipe;
  const briefMetricsAcc = createBriefMetricsAccumulator();
  let directorMetrics = {
    drillDownRan: false,
    drillDownSceneCount: 0,
    briefSceneMapCoverage: null,
    directorPath: null,
  };
  if (shouldUseSuperDirector(timelineIndex, abstraction, batchContext)) {
    const superResult = await runSuperDirectorDirectPath(client, context);
    recipe = superResult.recipe;
    directorMetrics = superResult.directorMetrics;
  } else {
    const directorResult = await runDirector(client, {
      ...context,
      onUsage: createUsageRecorder(gptUsageTracker, "direct"),
    });
    recipe = directorResult.recipe;
    briefMetricsAcc.record(directorResult.briefMetric);
    directorMetrics.directorPath = "classic";

    const sceneIds = extractSceneIdsFromRecipe(recipe);
    if (sceneIds.length > 0 && shouldRunDirectorDrillDown(recipe, context.batchContext, buildDrillDownOptions(context))) {
      const drillDownResult = await directorDrillDown(client, {
        ...context,
        recipe,
        sceneIds,
        onUsage: createUsageRecorder(gptUsageTracker, "drill_down"),
      });
      recipe = drillDownResult.recipe;
      directorMetrics = {
        ...directorMetrics,
        ...drillDownResult.directorMetrics,
      };
      briefMetricsAcc.record(drillDownResult.directorMetrics?.briefMetric);
    }

    directorMetrics = finalizeDirectorMetrics(directorMetrics, briefMetricsAcc);
  }

  if (!recipe.narrativeProfile) {
    const derived = resolveEffectiveNarrativeProfile({
      batchContext,
      abstraction,
      recipe,
    });
    if (derived) {
      recipe.narrativeProfile = derived;
    }
  }

  recipe.audioMixPlan = mergeAudioMixPlan(recipe, deriveAudioMixPlanDefaults({
    audioIndex,
    outputs: recipe.outputs,
    batchContext: {
      ...batchContext,
      requiredFormats,
    },
    musicSelection,
  }));

  const afterDirector = snapshotRecipeStage(recipe, "afterDirector");

  const enricherContext = {
    abstraction,
    timelineIndex,
    topicIndex,
    spatialIndex,
    audioIndex,
    clipRegistry,
    perClipAnalysis,
    batchContext,
    keyframeArtifacts,
    wordIndexes,
    metaCommandsByClip,
    aiVideoArtifact,
    musicBeatGrid,
    musicSelection,
  };
  const { enricherLog } = applyDeterministicRecipeEnrichersWithAudit(recipe, enricherContext);
  const afterEnrichers = snapshotRecipeStage(recipe, "afterEnrichers");

  writeRecipeProvenance(workDir, buildProvenanceDocument({
    batchId: recipe.batchId,
    afterDirector,
    afterEnrichers,
    enricherLog,
    stitchValidation: recipe.stitchValidation ?? null,
    superCriticReview: recipe.superCriticReview ?? null,
    directorMetrics,
  }));

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
  strictReview = false,
  force = false,
  faceStub = false,
  globalCacheDisabled = false,
  gptUsageTracker,
}) {
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const topicIndex = loadTopicIndex(workDir);
  const spatialIndex = await ensureSpatialIndex(workDir, { force, faceStub, globalCacheDisabled });
  const audioIndex = loadAudioIndex(workDir);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const wordIndexes = loadWordIndexes(workDir, catalog);
  const metaCommandsByClip = loadMetaCommandsByClip(workDir, catalog);
  const keyframeArtifacts = loadKeyframesByClip(workDir, catalog);
  const finalPath = path.join(workDir, ARTIFACTS.recipeFinal);

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
      perClipAnalysis,
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

  const existingProvenance = readRecipeProvenance(workDir) ?? {};
  let superCriticReview = existingProvenance.superCriticReview
    ?? recipe.superCriticReview
    ?? null;
  const usedSuperPath = existingProvenance.superCriticReview != null
    || (recipe.superPlanNotes?.length ?? 0) > 0
    || (recipe.structuredCallbacks?.length ?? 0) > 0;

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
    perClipAnalysis,
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
      superCriticReview,
      onUsage: createUsageRecorder(gptUsageTracker, "critic"),
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
        superCriticReview,
        attempt: iteration,
        onUsage: createUsageRecorder(
          gptUsageTracker,
          iteration > 1 ? "fixer_escalation" : "fixer",
        ),
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
      wordIndexes,
      metaCommandsByClip,
      aiVideoArtifact: loadAiVideoArtifact(workDir),
    });

    if (usedSuperPath) {
      const superPlan = reconstructSuperPlanFromRecipe(recipe, abstraction);
      const partials = (abstraction?.L2 ?? []).map((entry) => ({
        segmentId: entry.segmentId,
      }));
      superCriticReview = await runSuperCritic(client, {
        recipe,
        superPlan,
        abstraction,
        partials,
        timelineIndex,
        topicIndex,
        spatialIndex,
        audioIndex,
        perClipAnalysis,
        wordIndexes,
        onUsage: createUsageRecorder(gptUsageTracker, "super_critic"),
      });
      recipe.superCriticReview = superCriticReview;
      if (superCriticReview.crossSegmentNotes?.length) {
        recipe.superPlanNotes = [
          ...(recipe.superPlanNotes ?? []),
          ...superCriticReview.crossSegmentNotes,
        ];
      }
    }

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

  if (strictReview && !lastReview?.approved) {
    const error = new Error(
      `Receptura nie została zatwierdzona przez krytyka — nie zapisano ${ARTIFACTS.recipeFinal}`,
    );
    error.code = "RECIPE_REVIEW_NOT_APPROVED";
    error.validation = validation;
    error.review = lastReview;
    throw error;
  }

  const afterReview = snapshotRecipeStage(recipe, "afterReview");
  const { recipe: recipeForFinal, stitchValidation, superCriticReview: recipeSuperCritic } = stripRecipeProvenanceFields(recipe);

  writeRecipeProvenance(workDir, buildProvenanceDocument({
    batchId: recipe.batchId,
    afterDirector: existingProvenance.afterDirector ?? null,
    afterEnrichers: existingProvenance.afterEnrichers ?? null,
    afterReview,
    enricherLog: existingProvenance.enricherLog ?? [],
    stitchValidation: stitchValidation ?? existingProvenance.stitchValidation ?? null,
    superCriticReview: recipeSuperCritic ?? superCriticReview ?? existingProvenance.superCriticReview ?? null,
    reviewIterations: iteration,
    directorMetrics: existingProvenance.directorMetrics ?? null,
  }));

  writeJson(path.join(workDir, ARTIFACTS.recipeFinal), EditRecipeV2Schema.parse(recipeForFinal));

  return { recipe: recipeForFinal, review: lastReview, validation, finalWritten: true };
}
