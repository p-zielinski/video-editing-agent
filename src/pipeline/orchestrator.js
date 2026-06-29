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
import { runTranscribeStep } from "./steps/transcribe.js";
import { runAudioAnalysisStep } from "./steps/audio-analysis.js";
import { runKeyframesStep } from "./steps/keyframes.js";
import { runVisionStep, runObjectsStep } from "./steps/vision.js";
import { runIndexStep } from "./steps/index.js";
import { runClipProfileStep } from "./steps/clip-profile.js";
import { runTopicIndexStep } from "./steps/topic-index.js";
import { runSpatialIndexStep } from "./steps/spatial-index.js";
import { runAbstractStep, runDirectStep, runReviewStep, ensureSpatialIndex } from "./steps/agents.js";
import { runThumbnailsStep } from "./steps/thumbnails.js";
import {
  shouldUseCachedArtifact,
  isArtifactStale,
  recordManifestArtifactMtimes,
} from "./artifact-deps.js";
import { buildSceneCatalogFromDetection } from "./steps/ingest.js";
import { writeBatchQualityReport } from "../lib/batch-quality-report.js";

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
    sceneDetectStub = false,
    extractKeyframes = true,
    force = false,
    openaiClient,
    dateFrom,
    dateTo,
    sortBy = "mtime",
    thumbnailStub = false,
    renderThumbnails = true,
  } = options;

  const workDir = resolveWorkDir(batchId);
  fs.mkdirSync(workDir, { recursive: true });

  log.banner(`Video Editing Agent — batch ${batchId}`);
  log.log(`Work dir: ${workDir}`);
  if (force) {
    log.log("Tryb --force: pomijanie cache artefaktów");
  }

  const parsedContext = parseBatchContextFromUserContext(userContext);
  const contextExplicit = Array.isArray(parsedContext.requiredFormats) && parsedContext.requiredFormats.length > 0;
  const batchContext = resolveBatchContext(userContext, 0, requiredFormats, { contextExplicit });
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
  };
  let reviewResult = null;

  try {
    if (shouldRunStep("ingest", fromStep, toStep)) {
      if (!inputDir && shouldUseCachedArtifact(workDir, ARTIFACTS.manifest, force)) {
        log.step("ingest", stepIndex("ingest") + 1, TOTAL_STEPS);
        const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
        const clipCount = fs.existsSync(catalogPath)
          ? (readJson(catalogPath).clips?.length ?? 0)
          : 0;
        context.batchContext = resolveBatchContext(userContext, clipCount, requiredFormats);
        ensureManifestBatchContext(workDir, context.batchContext);
        log.stepDone("pominięto (istnieje manifest)");
      } else {
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
          }));
          const updatedCatalog = buildSceneCatalogFromDetection(
            batchId,
            clipsWithMeta,
            sceneDetectionByClip,
          );
          writeJson(path.join(workDir, ARTIFACTS.sceneCatalog), updatedCatalog);
          ingestResult = { ...ingestResult, catalog: updatedCatalog };
        }

        context.batchContext = resolveBatchContext(
          userContext,
          ingestResult.catalog.clips.length,
          requiredFormats,
        );
        ensureManifestBatchContext(workDir, context.batchContext);
        log.stepDone(`${ingestResult.catalog.clips.length} klipów (inputMode: ${context.batchContext.inputMode})`);
        recordManifestArtifactMtimes(workDir, [ARTIFACTS.manifest, ARTIFACTS.sceneCatalog]);
      }
    }

    if (shouldRunStep("transcribe", fromStep, toStep)) {
      log.step("transcribe", stepIndex("transcribe") + 1, TOTAL_STEPS);
      const words = await runTranscribeStep(context);
      log.stepDone(`${words.length} transkrypcji`);
      recordManifestArtifactMtimes(
        workDir,
        words.map((w) => ARTIFACTS.words(w.clipId)),
      );
    }

    if (shouldRunStep("audio_analysis", fromStep, toStep)) {
      log.step("audio_analysis", stepIndex("audio_analysis") + 1, TOTAL_STEPS);
      const audioIndex = await runAudioAnalysisStep({ ...context, stub: audioStub });
      log.stepDone(`${audioIndex.clips?.length ?? 0} klipów`);
      recordManifestArtifactMtimes(workDir, [
        ARTIFACTS.audioIndex,
        ...(audioIndex.clips ?? []).map((c) => ARTIFACTS.audioAnalysis(c.clipId)),
      ]);
    }

    if (shouldRunStep("keyframes", fromStep, toStep)) {
      log.step("keyframes", stepIndex("keyframes") + 1, TOTAL_STEPS);
      const keyframes = await runKeyframesStep({ ...context, extractImages: extractKeyframes });
      const total = keyframes.reduce((s, k) => s + (k.keyframes?.length ?? 0), 0);
      log.stepDone(`${total} klatek`);
      recordManifestArtifactMtimes(
        workDir,
        keyframes.map((k) => ARTIFACTS.keyframes(k.clipId)),
      );
    }

    if (shouldRunStep("vision", fromStep, toStep)) {
      log.step("vision", stepIndex("vision") + 1, TOTAL_STEPS);
      if (!visionStub) {
        await ensurePythonPreflight({ visionStub, objectsStub, objectsEnabled });
      }
      const vision = await runVisionStep({ ...context, stub: visionStub });
      log.stepDone();
      recordManifestArtifactMtimes(
        workDir,
        vision.map((v) => ARTIFACTS.vision(v.clipId)),
      );
    }

    if (shouldRunStep("objects", fromStep, toStep)) {
      log.step("objects", stepIndex("objects") + 1, TOTAL_STEPS);
      if (objectsEnabled && !objectsStub) {
        await ensurePythonPreflight({ visionStub, objectsStub, objectsEnabled });
      }
      const objects = await runObjectsStep({
        ...context,
        stub: objectsStub,
        enabled: objectsEnabled,
      });
      log.stepDone();
      recordManifestArtifactMtimes(
        workDir,
        objects.map((o) => ARTIFACTS.objects(o.clipId)),
      );
    }

    if (shouldRunStep("index", fromStep, toStep)) {
      log.step("index", stepIndex("index") + 1, TOTAL_STEPS);
      await runIndexStep({ workDir, userContext, force });
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.timelineIndex, ARTIFACTS.sceneCatalog]);
    }

    if (shouldRunStep("clip_profile", fromStep, toStep)) {
      log.step("clip_profile", stepIndex("clip_profile") + 1, TOTAL_STEPS);
      const registry = await runClipProfileStep({ workDir, userContext, force });
      log.stepDone(`${registry.clipRegistry?.length ?? 0} klipów w rejestrze`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.clipRegistry]);
    }

    if (shouldRunStep("abstract", fromStep, toStep)) {
      log.step("abstract", stepIndex("abstract") + 1, TOTAL_STEPS);
      await runAbstractStep(context);
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [
        ARTIFACTS.abstraction,
        ARTIFACTS.abstractionL1,
        ARTIFACTS.abstractionL2,
        ARTIFACTS.abstractionL3,
      ]);
    }

    if (shouldRunStep("topic_index", fromStep, toStep)) {
      log.step("topic_index", stepIndex("topic_index") + 1, TOTAL_STEPS);
      const topicIndex = await runTopicIndexStep({
        workDir,
        threshold: context.batchContext?.brollMatchThreshold ?? 0.55,
        force,
      });
      log.stepDone(`${topicIndex.topics?.length ?? 0} tematów`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.topicIndex]);
    }

    if (shouldRunStep("spatial_index", fromStep, toStep)) {
      log.step("spatial_index", stepIndex("spatial_index") + 1, TOTAL_STEPS);
      if (!faceStub) {
        await ensurePythonPreflight({ visionStub, faceStub, objectsStub, objectsEnabled, audioStub });
      }
      const spatialStale = isArtifactStale(workDir, ARTIFACTS.spatialIndex);
      const spatialIndex = await runSpatialIndexStep({ workDir, force: force || spatialStale, faceStub });
      log.stepDone(`${spatialIndex.scenes?.filter((s) => s.anchors.length > 0).length ?? 0} scen z kotwicami${spatialStale && !force ? " (odświeżono — stale)" : ""}`);
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.spatialIndex]);
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
      log.step("direct", stepIndex("direct") + 1, TOTAL_STEPS);
      await ensureSpatialIndex(workDir, { force, faceStub });
      await runDirectStep({ ...context, requiredFormats: context.requiredFormats, faceStub });
      log.stepDone();
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.recipeDraft]);
    }

    if (shouldRunStep("review", fromStep, toStep)) {
      log.step("review", stepIndex("review") + 1, TOTAL_STEPS);
      reviewResult = await runReviewStep({ ...context, requiredFormats: context.requiredFormats, faceStub });
      log.stepDone(reviewResult.review?.approved ? "zatwierdzono" : "wymaga przeglądu");
      recordManifestArtifactMtimes(workDir, [ARTIFACTS.review, ARTIFACTS.recipeFinal]);
    }

    if (shouldRunStep("thumbnails", fromStep, toStep)) {
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

    return {
      batchId,
      workDir,
      recipeFinal: path.join(workDir, ARTIFACTS.recipeFinal),
      review: reviewResult,
      validationFailed: false,
    };
  } catch (error) {
    if (error.code === "RECIPE_VALIDATION_FAILED") {
      log.pipelineFailed(error);
      return {
        batchId,
        workDir,
        recipeFinal: null,
        review: error.review,
        validation: error.validation,
        validationFailed: true,
      };
    }
    log.pipelineFailed(error);
    throw error;
  }
}

export { runSceneDetectionForClip };
