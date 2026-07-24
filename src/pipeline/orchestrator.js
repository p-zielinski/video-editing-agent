import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../lib/logger.js";
import { checkPythonPreflight } from "../lib/python-bridge.js";
import { detectInputMode, parseBatchContextFromUserContext } from "../lib/input-mode.js";
import {
  resolveEffectiveRequiredFormats,
  resolveFormatsSource,
} from "../lib/resolve-required-formats.js";
import { resolvePublishVoice } from "../editorial/publish-voice.js";
import {
  createBatchId,
  resolveWorkDir,
  shouldRunStep,
  writeJson,
  readJson,
  ARTIFACTS,
  PIPELINE_STEP_COUNT,
  stepIndex,
} from "./work-paths.js";
import { runIngestStep } from "./steps/ingest.js";
import { detectScenesForCatalog, runSceneDetectionForClip } from "./steps/scene-detect.js";
import { runAnalysisPhase, shouldUseAnalysisPhase } from "./analysis-phase.js";
import { runIndexStep } from "./steps/index.js";
import { runClipProfileStep } from "./steps/clip-profile.js";
import { runTopicIndexStep } from "./steps/topic-index.js";
import { runSpatialIndexStep } from "./steps/spatial-index.js";
import { runAiVideoStep } from "./steps/ai-video.js";
import { runAbstractStep, runDirectStep, runReviewStep, ensureSpatialIndex } from "./steps/agents.js";
import { runAudioEnhancementStep } from "./steps/audio-enhancement.js";
import { runThumbnailsStep } from "./steps/thumbnails.js";
import { runPublishStep } from "./steps/publish.js";
import {
  shouldUseCachedArtifact,
  isArtifactStale,
  recordManifestArtifactMtimes,
} from "./artifact-deps.js";
import { buildSceneCatalogFromDetection } from "./steps/ingest.js";
import { writeBatchQualityReport } from "../lib/batch-quality-report.js";
import { createGptUsageTracker, flushGptUsageIfNeeded } from "../lib/gpt-usage-log.js";
import { createDailyQuotaTrackerIfEnabled } from "../lib/openai-daily-usage.js";
import {
  createPipelineLedger,
  finalizePipelineSuccess,
  persistPipelineFailure,
  runTrackedStep,
} from "../lib/recovery/orchestrator-hooks.js";
import { formatRecoveryPlanReport } from "../lib/recovery/plan-writer.js";

const log = createLogger("pipeline");
const TOTAL_STEPS = PIPELINE_STEP_COUNT;

async function ensurePythonPreflight({ visionStub = false, faceStub = false, audioStub = false, objectsStub = false, objectsEnabled = true } = {}) {
  try {
    const result = await checkPythonPreflight({
      visionLive: !visionStub,
      faceLive: !faceStub,
      objectsLive: !objectsStub && objectsEnabled,
      audioLive: !audioStub,
    });
    for (const warning of result.warnings ?? []) {
      log.warn(warning);
    }
  } catch (error) {
    throw new Error(`Python preflight failed: ${error.message}`);
  }
}

function ensureManifestBatchContext(workDir, batchContext) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const manifest = readJson(manifestPath);
  if (manifest.batchContext) {
    return;
  }
  manifest.batchContext = batchContext;
  writeJson(manifestPath, manifest);
}

/**
 * Restore userContext / batchContext from manifest when resuming past ingest
 * with empty CLI context.
 */
export function hydrateContextFromManifest(workDir, context, {
  fromStep,
  aiVideo = false,
  aiVideoStub = false,
  noAiVideo = false,
} = {}) {
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  if (!fs.existsSync(manifestPath)) {
    return context;
  }

  const manifest = readJson(manifestPath);
  const resumingPastIngest = fromStep && stepIndex(fromStep) > stepIndex("ingest");
  const cliContextEmpty = !String(context.userContext ?? "").trim();

  if (cliContextEmpty && manifest.userContext) {
    context.userContext = manifest.userContext;
  }

  if ((resumingPastIngest || cliContextEmpty) && manifest.batchContext) {
    let clipCount = manifest.clipCount ?? 0;
    const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
    if (fs.existsSync(catalogPath)) {
      clipCount = readJson(catalogPath).clips?.length ?? clipCount;
    }

    const resolved = resolveBatchContext(
      context.userContext,
      clipCount,
      context.requiredFormats,
      { contextExplicit: context.requiredFormatsExplicit },
    );

    context.batchContext = applyAiVideoCliOverrides(
      {
        ...resolved,
        ...manifest.batchContext,
        requiredFormats: context.requiredFormatsExplicit
          ? context.requiredFormats
          : (manifest.batchContext.requiredFormats ?? resolved.requiredFormats),
        inputMode: manifest.batchContext.inputMode ?? resolved.inputMode,
        notes: manifest.batchContext.notes ?? resolved.notes,
      },
      { aiVideo, aiVideoStub, noAiVideo },
    );
  }

  return context;
}

export function applyAiVideoCliOverrides(
  batchContext,
  { aiVideo = false, aiVideoStub = false, noAiVideo = false } = {},
) {
  if (aiVideo === true || aiVideoStub === true) {
    batchContext.aiVideoEnabled = true;
  }
  if (noAiVideo === true) {
    batchContext.aiVideoEnabled = false;
  }
  return batchContext;
}

function resolveBatchContext(userContext, clipCount, requiredFormats, { contextExplicit = false } = {}) {
  const parsed = parseBatchContextFromUserContext(userContext);
  const hasContextFormats = Array.isArray(parsed.requiredFormats) && parsed.requiredFormats.length > 0;
  return {
    ...parsed,
    inputMode: detectInputMode(clipCount, parsed),
    requiredFormats: (contextExplicit || hasContextFormats) ? parsed.requiredFormats : requiredFormats,
    qualityOverQuantity: parsed.qualityOverQuantity ?? true,
    brollStrategy: parsed.brollStrategy ?? "match_speech_topics",
    brollMatchThreshold: parsed.brollMatchThreshold ?? 0.55,
    allowBrollReuse: parsed.allowBrollReuse ?? false,
    maxBrollSegmentsPerOutput: parsed.maxBrollSegmentsPerOutput ?? 30,
    shortsStrategy: parsed.shortsStrategy ?? "standalone_highlights",
    shortsMaxDurationSec: parsed.shortsMaxDurationSec ?? 60,
    allowWholeClipExclusion: parsed.allowWholeClipExclusion ?? true,
    notes: parsed.notes ?? (userContext && !userContext.trim().startsWith("{") ? userContext : parsed.notes),
    publishVoice: resolvePublishVoice({ batchContext: parsed, userContext }),
    aiVideoEnabled: parsed.aiVideoEnabled ?? false,
    aiVideoMaxPerBatch: parsed.aiVideoMaxPerBatch ?? 1,
    aiVideoMaxDurationSec: parsed.aiVideoMaxDurationSec ?? 5,
    aiVideoGenerateAudio: parsed.aiVideoGenerateAudio ?? false,
    aiVideoTargetOutputs: parsed.aiVideoTargetOutputs ?? ["9:16"],
    brandSafety: parsed.brandSafety ?? {
      enabled: true,
      preset: "social_strict",
      audio: parsed.profanityPolicy ?? "bleep",
      subtitles: parsed.profanitySubtitleMode ?? "partial",
      overlays: "partial",
      titles: "partial",
      thumbnails: "partial",
      publishText: "partial",
      llmPrompts: "masked",
    },
    colorGradePolicy: parsed.colorGradePolicy ?? "off",
  };
}

export function applyEffectiveRequiredFormats(context, {
  requiredFormatsExplicit = false,
  userContext,
  cliRequiredFormats,
} = {}) {
  const parsed = parseBatchContextFromUserContext(userContext);
  const contextExplicit = Array.isArray(parsed.requiredFormats) && parsed.requiredFormats.length > 0;

  let abstraction;
  const abstractPath = path.join(context.workDir, ARTIFACTS.abstraction);
  if (fs.existsSync(abstractPath)) {
    abstraction = readJson(abstractPath);
  }

  const effective = resolveEffectiveRequiredFormats({
    cliFormats: cliRequiredFormats,
    cliExplicit: requiredFormatsExplicit,
    contextFormats: parsed.requiredFormats,
    contextExplicit,
    l3RecommendedFormats: abstraction?.L3?.recommendedFormats,
  });

  const formatsSource = resolveFormatsSource({
    cliExplicit: requiredFormatsExplicit,
    contextExplicit,
    l3RecommendedFormats: abstraction?.L3?.recommendedFormats,
  });

  context.requiredFormats = effective;
  context.batchContext = {
    ...context.batchContext,
    requiredFormats: effective,
    formatsSource,
  };
  ensureManifestBatchContext(context.workDir, context.batchContext);
  return effective;
}

export async function runPipeline(options) {
  const {
    inputDir,
    batchId = createBatchId(),
    fromStep,
    toStep,
    apiKey,
    userContext = "",
    requiredFormats = ["16:9", "9:16"],
    requiredFormatsExplicit = false,
    visionStub = false,
    faceStub = false,
    audioStub = false,
    objectsEnabled = true,
    objectsStub = false,
    twelvelabsEnabled = true,
    twelvelabsStub,
    twelvelabsLive = false,
    sceneDetectStub = false,
    extractKeyframes = true,
    force = false,
    openaiClient,
    dateFrom,
    dateTo,
    sortBy = undefined,
    thumbnailStub = false,
    renderThumbnails = true,
    maxReviewIterations = 3,
    strictReview = false,
    topicIndexEmbedFn,
    globalCacheDisabled = false,
    aiVideo = false,
    aiVideoStub = false,
    noAiVideo = false,
    reuseLlmCache = false,
  } = options;

  const resolvedTwelvelabsStub = twelvelabsStub === true || !process.env.TWELVELABS_API_KEY;

  const workDir = resolveWorkDir(batchId);
  fs.mkdirSync(workDir, { recursive: true });

  if (reuseLlmCache === true) {
    process.env.LLM_REUSE_CACHE = "1";
    log.log("LLM reuse cache włączony (--reuse-llm-cache)");
  }

  log.banner(`Video Editing Agent — batch ${batchId}`);
  log.log(`Work dir: ${workDir}`);
  if (force) {
    log.log("Tryb --force: wymuszanie przeliczenia kroków (pomijanie cache artefaktów)");
  }
  if (globalCacheDisabled || process.env.DISABLE_GLOBAL_ANALYSIS_CACHE === "1") {
    log.log("Globalny cache analizy wyłączony (--no-global-cache lub DISABLE_GLOBAL_ANALYSIS_CACHE=1)");
  }

  const parsedContext = parseBatchContextFromUserContext(userContext);
  const contextExplicit = Array.isArray(parsedContext.requiredFormats) && parsedContext.requiredFormats.length > 0;
  const batchContext = applyAiVideoCliOverrides(
    resolveBatchContext(userContext, 0, requiredFormats, { contextExplicit }),
    { aiVideo, aiVideoStub, noAiVideo },
  );
  const resolvedAiVideoStub = aiVideoStub === true || process.env.AI_VIDEO_STUB === "1";
  const gptUsageTracker = createGptUsageTracker();
  const dailyQuotaTracker = createDailyQuotaTrackerIfEnabled({ batchId });
  const context = {
    workDir,
    batchId,
    apiKey,
    openaiClient,
    userContext,
    requiredFormats,
    requiredFormatsExplicit,
    batchContext,
    force,
    faceStub,
    audioStub,
    topicIndexEmbedFn,
    globalCacheDisabled,
    aiVideoStub: resolvedAiVideoStub,
    strictReview,
    gptUsageTracker,
    dailyQuotaTracker,
  };
  hydrateContextFromManifest(workDir, context, {
    fromStep,
    aiVideo,
    aiVideoStub,
    noAiVideo,
  });
  let reviewResult = null;
  const ledger = createPipelineLedger(workDir, batchId);
  let currentStep = null;

  try {
    if (shouldRunStep("ingest", fromStep, toStep)) {
      currentStep = "ingest";
      if (!inputDir && shouldUseCachedArtifact(workDir, ARTIFACTS.manifest, force)) {
        await runTrackedStep(ledger, "ingest", async () => {
        log.step("ingest", stepIndex("ingest") + 1, TOTAL_STEPS);
        const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
        const clipCount = fs.existsSync(catalogPath)
          ? (readJson(catalogPath).clips?.length ?? 0)
          : 0;
        context.batchContext = applyAiVideoCliOverrides(
          resolveBatchContext(userContext, clipCount, requiredFormats),
          { aiVideo, aiVideoStub, noAiVideo },
        );
        ensureManifestBatchContext(workDir, context.batchContext);
        log.stepDone("pominięto (istnieje manifest)");
        });
      } else {
        await runTrackedStep(ledger, "ingest", async () => {
        if (!inputDir) {
          throw new Error("Krok ingest wymaga --input <folder>");
        }
        log.step("ingest", stepIndex("ingest") + 1, TOTAL_STEPS);

        let ingestResult = await runIngestStep({
          inputDir,
          workDir,
          batchId,
          options: { userContext, sortBy, dateFrom, dateTo },
          force,
        });

        if (!sceneDetectStub) {
          await ensurePythonPreflight({ visionStub, objectsStub, objectsEnabled });
          const sceneDetectionByClip = await detectScenesForCatalog(ingestResult.catalog, {
            stub: false,
          });
          const clipsWithMeta = ingestResult.catalog.clips.map((c) => ({
            sourcePath: c.sourcePath,
            fileName: c.fileName,
            durationSec: c.durationSec,
            creationTime: c.creationTime,
            aspectRatio: c.aspectRatio,
            resolution: c.resolution,
            ...(c.mediaType ? { mediaType: c.mediaType } : {}),
            ...(c.sortIndex != null ? { sortIndex: c.sortIndex } : {}),
          }));
          const updatedCatalog = buildSceneCatalogFromDetection(
            batchId,
            clipsWithMeta,
            sceneDetectionByClip,
          );
          writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), updatedCatalog);
          ingestResult = { ...ingestResult, catalog: updatedCatalog };
        }

        context.batchContext = applyAiVideoCliOverrides(
          resolveBatchContext(
            userContext,
            ingestResult.catalog.clips.length,
            requiredFormats,
          ),
          { aiVideo, aiVideoStub, noAiVideo },
        );
        ensureManifestBatchContext(workDir, context.batchContext);
        log.stepDone(`${ingestResult.catalog.clips.length} klipów (inputMode: ${context.batchContext.inputMode})`);
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.manifest, ARTIFACTS.sceneCatalog]);
        });
      }
    }

    if (shouldRunStep("audio_enhancement", fromStep, toStep)) {
      currentStep = "audio_enhancement";
      await runTrackedStep(ledger, "audio_enhancement", async () => {
        log.step("audio_enhancement", stepIndex("audio_enhancement") + 1, TOTAL_STEPS);
        await runAudioEnhancementStep({ workDir, force });
        log.stepDone();
        const enhancementArtifacts = [ARTIFACTS.audioEnhancementIndex];
        if (fs.existsSync(path.join(workDir, ARTIFACTS.recipeDraft))) {
          enhancementArtifacts.push(ARTIFACTS.recipeDraft);
        }
        recordManifestArtifactMtimes(workDir, enhancementArtifacts);
      });
    }

    if (shouldUseAnalysisPhase(fromStep, toStep, { twelvelabsEnabled })) {
      currentStep = "transcribe";
      const needsVisionPreflight = shouldRunStep("vision", fromStep, toStep) && !visionStub;
      const needsObjectsPreflight = objectsEnabled
        && shouldRunStep("objects", fromStep, toStep)
        && !objectsStub;
      if (needsVisionPreflight || needsObjectsPreflight) {
        await ensurePythonPreflight({ visionStub, objectsStub, objectsEnabled });
      }

      const analysisResult = await runAnalysisPhase({
        workDir,
        fromStep,
        toStep,
        twelvelabsEnabled,
        apiKey,
        audioStub,
        visionStub,
        objectsEnabled,
        objectsStub,
        twelvelabsStub: resolvedTwelvelabsStub,
        extractKeyframes,
        force,
        globalCacheDisabled,
        dailyQuotaTracker,
        batchId,
        gptUsageTracker,
        ledger,
      });

      if (shouldRunStep("transcribe", fromStep, toStep)) {
        log.step("transcribe", stepIndex("transcribe") + 1, TOTAL_STEPS);
        const words = analysisResult.words ?? [];
        log.stepDone(`${words.length} transkrypcji`);
        recordManifestArtifactMtimes(
          workDir,
          words.map((w) => ARTIFACTS.words(w.clipId)),
        );
      }

      if (shouldRunStep("meta_commands", fromStep, toStep)) {
        log.step("meta_commands", stepIndex("meta_commands") + 1, TOTAL_STEPS);
        const metaCommands = analysisResult.metaCommands ?? [];
        const total = metaCommands.reduce((sum, entry) => sum + (entry.commands?.length ?? 0), 0);
        log.stepDone(`${total} meta-komend`);
        recordManifestArtifactMtimes(
          workDir,
          metaCommands.map((entry) => ARTIFACTS.metaCommands(entry.clipId)),
        );
      }

      if (shouldRunStep("audio_analysis", fromStep, toStep)) {
        log.step("audio_analysis", stepIndex("audio_analysis") + 1, TOTAL_STEPS);
        const audioIndex = analysisResult.audioIndex ?? { clips: [] };
        log.stepDone(`${audioIndex.clips?.length ?? 0} klipów`);
        recordManifestArtifactMtimes(workDir, [
          ARTIFACTS.audioIndex,
          ...(audioIndex.clips ?? []).map((c) => ARTIFACTS.audioAnalysis(c.clipId)),
        ]);
      }

      if (shouldRunStep("keyframes", fromStep, toStep)) {
        log.step("keyframes", stepIndex("keyframes") + 1, TOTAL_STEPS);
        const keyframes = analysisResult.keyframes ?? [];
        const total = keyframes.reduce((s, k) => s + (k.keyframes?.length ?? 0), 0);
        log.stepDone(`${total} klatek`);
        recordManifestArtifactMtimes(
          workDir,
          keyframes.map((k) => ARTIFACTS.keyframes(k.clipId)),
        );
      }

      if (twelvelabsEnabled && shouldRunStep("twelvelabs", fromStep, toStep)) {
        log.step("twelvelabs", stepIndex("twelvelabs") + 1, TOTAL_STEPS);
        const twelvelabs = analysisResult.twelvelabs ?? [];
        log.stepDone(resolvedTwelvelabsStub ? "stub" : "live");
        recordManifestArtifactMtimes(
          workDir,
          twelvelabs.map((t) => ARTIFACTS.twelvelabs(t.clipId)),
        );
      }

      if (shouldRunStep("vision", fromStep, toStep)) {
        log.step("vision", stepIndex("vision") + 1, TOTAL_STEPS);
        const vision = analysisResult.vision ?? [];
        log.stepDone();
        recordManifestArtifactMtimes(
          workDir,
          vision.map((v) => ARTIFACTS.vision(v.clipId)),
        );
      }

      if (shouldRunStep("objects", fromStep, toStep)) {
        log.step("objects", stepIndex("objects") + 1, TOTAL_STEPS);
        const objects = analysisResult.objects ?? [];
        log.stepDone();
        recordManifestArtifactMtimes(
          workDir,
          objects.map((o) => ARTIFACTS.objects(o.clipId)),
        );
      }
    }

    if (shouldRunStep("index", fromStep, toStep)) {
      currentStep = "index";
      await runTrackedStep(ledger, "index", async () => {
      log.step("index", stepIndex("index") + 1, TOTAL_STEPS);
      await runIndexStep({ workDir, userContext, force });
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.timelineIndex, ARTIFACTS.sceneCatalog]);
      });
    }

    if (shouldRunStep("clip_profile", fromStep, toStep)) {
      currentStep = "clip_profile";
      await runTrackedStep(ledger, "clip_profile", async () => {
      log.step("clip_profile", stepIndex("clip_profile") + 1, TOTAL_STEPS);
      const registry = await runClipProfileStep({ workDir, userContext, force });
      log.stepDone(`${registry.clipRegistry?.length ?? 0} klipów w rejestrze`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.clipRegistry]);
      });
    }

    if (shouldRunStep("abstract", fromStep, toStep)) {
      currentStep = "abstract";
      await runTrackedStep(ledger, "abstract", async () => {
      log.step("abstract", stepIndex("abstract") + 1, TOTAL_STEPS);
      await runAbstractStep(context);
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [
        ARTIFACTS.abstraction,
        ARTIFACTS.abstractionL1,
        ARTIFACTS.abstractionL2,
        ARTIFACTS.abstractionL3,
      ]);
      const usagePath = flushGptUsageIfNeeded(workDir, gptUsageTracker, { batchId, log });
      if (usagePath) {
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.gptUsage]);
      }
      });
    }

    if (shouldRunStep("topic_index", fromStep, toStep)) {
      currentStep = "topic_index";
      await runTrackedStep(ledger, "topic_index", async () => {
      log.step("topic_index", stepIndex("topic_index") + 1, TOTAL_STEPS);
      const topicIndex = await runTopicIndexStep({
        workDir,
        threshold: context.batchContext?.brollMatchThreshold ?? 0.55,
        force,
        apiKey: context.apiKey,
        embedFn: context.topicIndexEmbedFn,
        dailyQuotaTracker,
        batchId,
      });
      log.stepDone(`${topicIndex.topics?.length ?? 0} tematów`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.topicIndex]);
      });
    }

    if (shouldRunStep("spatial_index", fromStep, toStep)) {
      currentStep = "spatial_index";
      await runTrackedStep(ledger, "spatial_index", async () => {
      log.step("spatial_index", stepIndex("spatial_index") + 1, TOTAL_STEPS);
      if (!faceStub) {
        await ensurePythonPreflight({ visionStub, faceStub, objectsStub, objectsEnabled, audioStub });
      }
      const spatialStale = isArtifactStale(workDir, ARTIFACTS.spatialIndex);
      const spatialIndex = await runSpatialIndexStep({
        workDir,
        force: force || spatialStale,
        faceStub,
        globalCacheDisabled,
      });
      log.stepDone(`${spatialIndex.scenes?.filter((s) => s.anchors.length > 0).length ?? 0} scen z kotwicami${spatialStale && !force ? " (odświeżono — stale)" : ""}`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.spatialIndex]);
      });
    }

    if (shouldRunStep("ai_video", fromStep, toStep)) {
      currentStep = "ai_video";
      await runTrackedStep(ledger, "ai_video", async () => {
      log.step("ai_video", stepIndex("ai_video") + 1, TOTAL_STEPS);
      const aiVideoResult = await runAiVideoStep({
        workDir,
        batchContext: context.batchContext,
        force,
        useStub: resolvedAiVideoStub,
        analyzeWithTwelveLabs: twelvelabsEnabled,
        twelveLabsStub: resolvedTwelvelabsStub,
        twelveLabsApiKey: process.env.TWELVELABS_API_KEY,
        globalCacheDisabled,
      });
      const statusLabel = aiVideoResult.status ?? "unknown";
      log.stepDone(statusLabel);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.aiVideo, ARTIFACTS.sceneCatalog, ARTIFACTS.clipRegistry]);
      });
    }

    if (shouldRunStep("direct", fromStep, toStep) || shouldRunStep("review", fromStep, toStep)) {
      const effectiveFormats = applyEffectiveRequiredFormats(context, {
        requiredFormatsExplicit,
        userContext,
        cliRequiredFormats: requiredFormats,
      });
      if (effectiveFormats.join(",") !== requiredFormats.join(",")) {
        log.detail(`Formaty wyjściowe z L3: ${effectiveFormats.join(", ")} (źródło: ${context.batchContext.formatsSource})`);
      }
    }

    if (shouldRunStep("direct", fromStep, toStep)) {
      currentStep = "direct";
      await runTrackedStep(ledger, "direct", async () => {
      log.step("direct", stepIndex("direct") + 1, TOTAL_STEPS);
      await ensureSpatialIndex(workDir, { force, faceStub, globalCacheDisabled });
      await runDirectStep({ ...context, requiredFormats: context.requiredFormats, faceStub });
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.recipeDraft]);
      const usagePath = flushGptUsageIfNeeded(workDir, gptUsageTracker, { batchId, log });
      if (usagePath) {
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.gptUsage]);
      }
      });
    }

    if (shouldRunStep("review", fromStep, toStep)) {
      currentStep = "review";
      await runTrackedStep(ledger, "review", async () => {
      log.step("review", stepIndex("review") + 1, TOTAL_STEPS);
      reviewResult = await runReviewStep({
        ...context,
        requiredFormats: context.requiredFormats,
        faceStub,
        maxIterations: maxReviewIterations,
        strictReview,
      });
      log.stepDone(reviewResult.review?.approved ? "zatwierdzono" : "wymaga przeglądu");
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.review, ARTIFACTS.recipeFinal]);
      const usagePath = flushGptUsageIfNeeded(workDir, gptUsageTracker, { batchId, log });
      if (usagePath) {
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.gptUsage]);
      }
      });
    }

    if (shouldRunStep("thumbnails", fromStep, toStep)) {
      currentStep = "thumbnails";
      await runTrackedStep(ledger, "thumbnails", async () => {
      log.step("thumbnails", stepIndex("thumbnails") + 1, TOTAL_STEPS);
      const thumbnailResult = await runThumbnailsStep({
        ...context,
        thumbnailStub,
        renderImages: renderThumbnails,
      });
      const variantCount = (thumbnailResult.plan.outputs ?? []).reduce(
        (sum, output) => sum + (output.variants?.length ?? 0),
        0,
      );
      log.stepDone(`${variantCount} wariantów${thumbnailResult.review.approved ? "" : " (wymaga przeglądu)"}`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.thumbnailPlan, ARTIFACTS.thumbnailReview]);
      const usagePath = flushGptUsageIfNeeded(workDir, gptUsageTracker, { batchId, log });
      if (usagePath) {
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.gptUsage]);
      }
      });
    }

    if (shouldRunStep("publish", fromStep, toStep)) {
      currentStep = "publish";
      await runTrackedStep(ledger, "publish", async () => {
      log.step("publish", stepIndex("publish") + 1, TOTAL_STEPS);
      const publishResult = await runPublishStep({ workDir, force });
      const packageCount = Object.keys(publishResult.packages ?? {}).length;
      log.stepDone(`${packageCount} pakietów`);
      recordManifestArtifactMtimes(
        workDir,
        (readJson(path.join(workDir, ARTIFACTS.recipeFinal)).outputs ?? []).map(
          (output) => ARTIFACTS.publishPackage(output.outputId),
        ),
      );
      });
    }

    if (shouldRunStep("review", fromStep, toStep) || toStep === "review" || !toStep) {
      try {
        const { summary, outPath } = writeBatchQualityReport(workDir);
        log.detail(summary.replace(/\n/g, "\n  "));
        log.detail(`Raport jakości: ${outPath}`);
      } catch (error) {
        log.warn(`Nie udało się wygenerować raportu jakości: ${error.message}`);
      }
    }

    log.pipelineDone();
    finalizePipelineSuccess(ledger, workDir);

    return {
      batchId,
      workDir,
      recipeFinal: path.join(workDir, ARTIFACTS.recipeFinal),
      review: reviewResult,
      validationFailed: false,
    };
  } catch (error) {
    flushGptUsageIfNeeded(workDir, gptUsageTracker, { batchId, log });
    const recoveryPlan = persistPipelineFailure({
      error,
      batchId,
      workDir,
      ledger,
      step: currentStep,
    });
    log.detail(formatRecoveryPlanReport(recoveryPlan, { workDir }));
    if (error.code === "RECIPE_VALIDATION_FAILED") {
      log.pipelineFailed(error);
      return {
        batchId,
        workDir,
        recipeFinal: null,
        review: error.review,
        validation: error.validation,
        validationFailed: true,
        recoveryPlan,
      };
    }
    log.pipelineFailed(error);
    error.recoveryPlan = recoveryPlan;
    throw error;
  }
}

export { runSceneDetectionForClip };
