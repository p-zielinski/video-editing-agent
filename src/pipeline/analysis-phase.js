import fs from "node:fs";
import path from "node:path";
import {
  getAudioConcurrencyLimit,
  getClipConcurrencyLimit,
  getGpuConcurrencyLimit,
  isAnalysisParallelClips,
  isAnalysisParallelGpuSteps,
  runWithConcurrency,
} from "../lib/clip-concurrency.js";
import { buildStepConfigFingerprint } from "../lib/config-fingerprint.js";
import { buildAnalysisWaveFailure } from "../lib/recovery/plan-writer.js";
import { readJson, ARTIFACTS, shouldRunStep } from "./work-paths.js";
import { transcribeClip } from "./steps/transcribe.js";
import { runMetaCommandsStep } from "./steps/meta-commands.js";
import { analyzeClipAudio, buildAudioIndexFromAnalyses, enrichClipWithDeliveryAnalysis } from "./steps/audio-analysis.js";
import { processClipKeyframes } from "./steps/keyframes.js";
import { processClipTwelveLabs } from "./steps/twelvelabs.js";
import { processClipVision, processClipObjects } from "./steps/vision.js";

export const ANALYSIS_PHASE_STEPS = [
  "transcribe",
  "meta_commands",
  "audio_analysis",
  "keyframes",
  "twelvelabs",
  "vision",
  "objects",
];

export function shouldUseAnalysisPhase(fromStep, toStep, { twelvelabsEnabled = true } = {}) {
  const steps = ANALYSIS_PHASE_STEPS.filter(
    (step) => step !== "twelvelabs" || twelvelabsEnabled,
  );
  return steps.some((step) => shouldRunStep(step, fromStep, toStep));
}

function loadClipRegistryEntries(workDir) {
  const registryPath = path.join(workDir, ARTIFACTS.clipRegistry);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const data = readJson(registryPath);
  return data.clipRegistry ?? data;
}

function unwrapWaveResults(waveOutput) {
  if (Array.isArray(waveOutput)) {
    return { results: waveOutput, errors: [] };
  }
  return waveOutput;
}

function assertWaveSuccess(step, waveOutput, batchId, ledger = null) {
  const { results, errors } = unwrapWaveResults(waveOutput);
  if (errors.length === 0) {
    return results;
  }
  for (const entry of errors) {
    const clipId = entry.item?.clipId ?? `index-${entry.index}`;
    ledger?.recordClipOutcome(step, clipId, "failed", entry.error);
  }
  const waveError = buildAnalysisWaveFailure(step, errors, batchId);
  ledger?.failStep(step, waveError);
  throw waveError;
}

async function runClipWave(items, fn, options) {
  return runWithConcurrency(items, fn, { ...options, onError: "collect" });
}

function loadWordsForClip(workDir, clip) {
  const wordsPath = path.join(workDir, ARTIFACTS.words(clip.clipId));
  return fs.existsSync(wordsPath) ? readJson(wordsPath) : null;
}

function resolveWordsForClip(wordsByClip, clip, index, workDir) {
  if (Array.isArray(wordsByClip)) {
    return wordsByClip[index]
      ?? wordsByClip.find((entry) => entry?.clipId === clip.clipId)
      ?? loadWordsForClip(workDir, clip);
  }
  return loadWordsForClip(workDir, clip);
}

function buildAnalysisContext({
  workDir,
  fromStep,
  toStep,
  twelvelabsEnabled,
  apiKey,
  audioStub,
  visionStub,
  objectsEnabled,
  objectsStub,
  twelvelabsStub,
  force,
  globalCacheDisabled,
  globalCacheRoot,
  dailyQuotaTracker,
  batchId,
  gptUsageTracker,
}) {
  const runTranscribe = shouldRunStep("transcribe", fromStep, toStep);
  const runMetaCommands = shouldRunStep("meta_commands", fromStep, toStep);
  const runAudio = shouldRunStep("audio_analysis", fromStep, toStep);
  const runTwelve = twelvelabsEnabled && shouldRunStep("twelvelabs", fromStep, toStep);
  const runKf = shouldRunStep("keyframes", fromStep, toStep);
  const runVision = shouldRunStep("vision", fromStep, toStep);
  const runObjects = objectsEnabled && shouldRunStep("objects", fromStep, toStep);

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const manifestPath = path.join(workDir, ARTIFACTS.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const clips = catalog.clips;
  const resolvedBatchId = batchId ?? manifest?.batchId ?? catalog.batchId;

  const expectedTerms = Array.isArray(manifest?.batchContext?.expectedTerms)
    ? manifest.batchContext.expectedTerms
    : [];
  const wordsFingerprint = buildStepConfigFingerprint("words", { expectedTerms });
  const resolvedTwelveKey = process.env.TWELVELABS_API_KEY;
  const useTwelveStub = twelvelabsStub ?? !resolvedTwelveKey;
  const twelveFingerprint = buildStepConfigFingerprint("twelvelabs", {
    useStub: useTwelveStub,
    twelvelabsLive: !useTwelveStub,
  });
  const visionFingerprint = buildStepConfigFingerprint("vision", { stub: visionStub });
  const objectsFingerprint = buildStepConfigFingerprint("objects", {
    stub: objectsStub,
    enabled: objectsEnabled,
  });

  return {
    workDir,
    clips,
    manifest,
    resolvedBatchId,
    runTranscribe,
    runMetaCommands,
    runAudio,
    runTwelve,
    runKf,
    runVision,
    runObjects,
    apiKey,
    audioStub,
    visionStub,
    objectsEnabled,
    objectsStub,
    force,
    globalCacheDisabled,
    globalCacheRoot,
    dailyQuotaTracker,
    gptUsageTracker,
    wordsFingerprint,
    resolvedTwelveKey,
    useTwelveStub,
    twelveFingerprint,
    visionFingerprint,
    objectsFingerprint,
    catalog,
  };
}

async function runTrackedAnalysisStep(step, enabled, ledger, fn) {
  if (!enabled) {
    return null;
  }
  ledger?.beginStep(step);
  try {
    const value = await fn();
    ledger?.finishStep(step, "succeeded");
    return value;
  } catch (error) {
    ledger?.failStep(step, error);
    throw error;
  }
}

async function runTranscribeWave(ctx, ledger) {
  if (!ctx.runTranscribe) {
    return null;
  }
  ledger?.beginStep("transcribe");
  const output = await runClipWave(
    ctx.clips,
    (clip) => transcribeClip({
      workDir: ctx.workDir,
      clip,
      apiKey: ctx.apiKey,
      force: ctx.force,
      globalCacheDisabled: ctx.globalCacheDisabled,
      manifest: ctx.manifest,
      configFingerprint: ctx.wordsFingerprint,
      dailyQuotaTracker: ctx.dailyQuotaTracker,
      batchId: ctx.resolvedBatchId,
      gptUsageTracker: ctx.gptUsageTracker,
    }),
    { limit: getClipConcurrencyLimit(), label: "transcribe" },
  );
  const results = assertWaveSuccess("transcribe", output, ctx.resolvedBatchId, ledger);
  ledger?.finishStep("transcribe", "succeeded");
  return results;
}

async function runMetaCommandsStepTracked(ctx, ledger, wordsByClip) {
  if (!ctx.runMetaCommands) {
    return null;
  }
  return runTrackedAnalysisStep("meta_commands", true, ledger, () => runMetaCommandsStep({
    workDir: ctx.workDir,
    force: ctx.force,
    wordsByClip,
  }));
}

async function runAudioWaveAndIndex(ctx, ledger, wordsByClip = null) {
  if (!ctx.runAudio) {
    return null;
  }
  ledger?.beginStep("audio_analysis");
  const audioOutput = await runClipWave(
    ctx.clips,
    (clip) => analyzeClipAudio({
      workDir: ctx.workDir,
      clip,
      manifest: ctx.manifest,
      stub: ctx.audioStub,
      force: ctx.force,
      globalCacheDisabled: ctx.globalCacheDisabled,
    }),
    { limit: Math.min(getClipConcurrencyLimit(), getAudioConcurrencyLimit()), label: "audio_analysis" },
  );
  const perClipAnalysis = assertWaveSuccess("audio_analysis", audioOutput, ctx.resolvedBatchId, ledger);

  const deliveryOutput = await runClipWave(
    ctx.clips.map((clip, index) => ({
      clip,
      audio: perClipAnalysis[index],
      words: resolveWordsForClip(wordsByClip, clip, index, ctx.workDir),
    })),
    async ({ clip, audio, words }) => {
      if (!audio || !words?.words?.length) {
        return audio;
      }
      return enrichClipWithDeliveryAnalysis(audio, {
        workDir: ctx.workDir,
        clip,
        words,
        stub: ctx.audioStub,
      });
    },
    { limit: getClipConcurrencyLimit(), label: "delivery_analysis" },
  );
  const enriched = assertWaveSuccess("audio_analysis", deliveryOutput, ctx.resolvedBatchId, ledger)
    .filter(Boolean);
  const audioIndex = buildAudioIndexFromAnalyses(ctx.workDir, ctx.catalog, enriched, { force: ctx.force });
  ledger?.finishStep("audio_analysis", "succeeded");
  return audioIndex;
}

async function runTwelveLabsWave(ctx, ledger) {
  if (!ctx.runTwelve) {
    return null;
  }
  ledger?.beginStep("twelvelabs");
  const output = await runClipWave(
    ctx.clips,
    (clip) => processClipTwelveLabs({
      workDir: ctx.workDir,
      clip,
      manifest: ctx.manifest,
      useStub: ctx.useTwelveStub,
      force: ctx.force,
      apiKey: ctx.resolvedTwelveKey,
      openaiApiKey: ctx.apiKey ?? process.env.OPENAI_API_KEY,
      configFingerprint: ctx.twelveFingerprint,
      globalCacheDisabled: ctx.globalCacheDisabled,
      globalCacheRoot: ctx.globalCacheRoot,
      dailyQuotaTracker: ctx.dailyQuotaTracker,
      gptUsageTracker: ctx.gptUsageTracker,
      batchId: ctx.resolvedBatchId,
    }),
    { limit: getClipConcurrencyLimit(), label: "twelvelabs" },
  );
  const results = assertWaveSuccess("twelvelabs", output, ctx.resolvedBatchId, ledger);
  ledger?.finishStep("twelvelabs", "succeeded");
  return results;
}

async function runKeyframesWave(ctx, ledger, { extractKeyframes, extractFrameAtFn }) {
  if (!ctx.runKf) {
    return null;
  }
  ledger?.beginStep("keyframes");
  const clipRegistry = loadClipRegistryEntries(ctx.workDir);
  const output = await runClipWave(
    ctx.clips,
    (clip) => processClipKeyframes({
      workDir: ctx.workDir,
      clip,
      catalog: ctx.catalog,
      manifest: ctx.manifest,
      clipRegistry,
      extractImages: extractKeyframes,
      force: ctx.force,
      globalCacheDisabled: ctx.globalCacheDisabled,
      globalCacheRoot: ctx.globalCacheRoot,
      extractFrameAtFn,
    }),
    { limit: getClipConcurrencyLimit(), label: "keyframes" },
  );
  const results = assertWaveSuccess("keyframes", output, ctx.resolvedBatchId, ledger);
  ledger?.finishStep("keyframes", "succeeded");
  return results;
}

async function runVisionWave(ctx, ledger) {
  if (!ctx.runVision) {
    return null;
  }
  ledger?.beginStep("vision");
  const output = await runClipWave(
    ctx.clips,
    (clip) => processClipVision({
      workDir: ctx.workDir,
      clip,
      manifest: ctx.manifest,
      stub: ctx.visionStub,
      force: ctx.force,
      globalCacheDisabled: ctx.globalCacheDisabled,
      globalCacheRoot: ctx.globalCacheRoot,
      configFingerprint: ctx.visionFingerprint,
    }),
    { limit: getGpuConcurrencyLimit(), label: "vision" },
  );
  const results = assertWaveSuccess("vision", output, ctx.resolvedBatchId, ledger);
  ledger?.finishStep("vision", "succeeded");
  return results;
}

async function runObjectsWave(ctx, ledger) {
  if (!ctx.runObjects) {
    return null;
  }
  ledger?.beginStep("objects");
  const output = await runClipWave(
    ctx.clips,
    (clip) => processClipObjects({
      workDir: ctx.workDir,
      clip,
      manifest: ctx.manifest,
      stub: ctx.objectsStub,
      force: ctx.force,
      globalCacheDisabled: ctx.globalCacheDisabled,
      globalCacheRoot: ctx.globalCacheRoot,
      configFingerprint: ctx.objectsFingerprint,
    }),
    { limit: getGpuConcurrencyLimit(), label: "objects" },
  );
  const results = assertWaveSuccess("objects", output, ctx.resolvedBatchId, ledger);
  ledger?.finishStep("objects", "succeeded");
  return results;
}

async function runParallelGpuWave(ctx, ledger) {
  if (!ctx.runVision && !ctx.runObjects) {
    return { vision: null, objects: null };
  }
  if (ctx.runVision) {
    ledger?.beginStep("vision");
  }
  if (ctx.runObjects) {
    ledger?.beginStep("objects");
  }

  const waveCOutput = await runClipWave(
    ctx.clips,
    async (clip) => {
      const clipResult = {};
      const tasks = [];

      if (ctx.runVision) {
        tasks.push(
          processClipVision({
            workDir: ctx.workDir,
            clip,
            manifest: ctx.manifest,
            stub: ctx.visionStub,
            force: ctx.force,
            globalCacheDisabled: ctx.globalCacheDisabled,
            globalCacheRoot: ctx.globalCacheRoot,
            configFingerprint: ctx.visionFingerprint,
          }).then((vision) => {
            clipResult.vision = vision;
          }),
        );
      }

      if (ctx.runObjects) {
        tasks.push(
          processClipObjects({
            workDir: ctx.workDir,
            clip,
            manifest: ctx.manifest,
            stub: ctx.objectsStub,
            force: ctx.force,
            globalCacheDisabled: ctx.globalCacheDisabled,
            globalCacheRoot: ctx.globalCacheRoot,
            configFingerprint: ctx.objectsFingerprint,
          }).then((objects) => {
            clipResult.objects = objects;
          }),
        );
      }

      await Promise.all(tasks);
      return clipResult;
    },
    { limit: getGpuConcurrencyLimit(), label: "analysis-wave-c" },
  );

  const waveCStep = ctx.runVision ? "vision" : "objects";
  const waveCResults = assertWaveSuccess(waveCStep, waveCOutput, ctx.resolvedBatchId, ledger);

  if (ctx.runVision) {
    ledger?.finishStep("vision", "succeeded");
  }
  if (ctx.runObjects) {
    ledger?.finishStep("objects", "succeeded");
  }

  return {
    vision: ctx.runVision ? waveCResults.map((entry) => entry.vision).filter(Boolean) : null,
    objects: ctx.runObjects ? waveCResults.map((entry) => entry.objects).filter(Boolean) : null,
  };
}

async function runAnalysisPhaseSequential(ctx, ledger, waveOptions) {
  const result = {
    words: null,
    metaCommands: null,
    audioIndex: null,
    keyframes: null,
    twelvelabs: null,
    vision: null,
    objects: null,
  };

  result.words = await runTranscribeWave(ctx, ledger);
  result.metaCommands = await runMetaCommandsStepTracked(ctx, ledger, result.words);
  result.audioIndex = await runAudioWaveAndIndex(ctx, ledger, result.words);
  result.twelvelabs = await runTwelveLabsWave(ctx, ledger);
  result.keyframes = await runKeyframesWave(ctx, ledger, waveOptions);
  result.vision = await runVisionWave(ctx, ledger);
  result.objects = await runObjectsWave(ctx, ledger);

  return result;
}

async function runAnalysisPhaseWaves(ctx, ledger, waveOptions, { parallelClips, parallelGpuSteps }) {
  const result = {
    words: null,
    metaCommands: null,
    audioIndex: null,
    keyframes: null,
    twelvelabs: null,
    vision: null,
    objects: null,
  };

  if (parallelClips && (ctx.runTranscribe || ctx.runAudio || ctx.runTwelve)) {
    const waveALimit = ctx.runAudio
      ? Math.min(getClipConcurrencyLimit(), getAudioConcurrencyLimit())
      : getClipConcurrencyLimit();

    if (ctx.runTranscribe) {
      ledger?.beginStep("transcribe");
    }
    if (ctx.runTwelve) {
      ledger?.beginStep("twelvelabs");
    }

    const waveAOutput = await runClipWave(
      ctx.clips,
      async (clip) => {
        const clipResult = {};

        if (ctx.runTranscribe) {
          clipResult.words = await transcribeClip({
            workDir: ctx.workDir,
            clip,
            apiKey: ctx.apiKey,
            force: ctx.force,
            globalCacheDisabled: ctx.globalCacheDisabled,
            manifest: ctx.manifest,
            configFingerprint: ctx.wordsFingerprint,
            dailyQuotaTracker: ctx.dailyQuotaTracker,
            batchId: ctx.resolvedBatchId,
            gptUsageTracker: ctx.gptUsageTracker,
          });
        }

        if (ctx.runAudio) {
          clipResult.audio = await analyzeClipAudio({
            workDir: ctx.workDir,
            clip,
            manifest: ctx.manifest,
            stub: ctx.audioStub,
            force: ctx.force,
            globalCacheDisabled: ctx.globalCacheDisabled,
          });
        }

        if (ctx.runTwelve) {
          clipResult.twelve = await processClipTwelveLabs({
            workDir: ctx.workDir,
            clip,
            manifest: ctx.manifest,
            useStub: ctx.useTwelveStub,
            force: ctx.force,
            apiKey: ctx.resolvedTwelveKey,
            openaiApiKey: ctx.apiKey ?? process.env.OPENAI_API_KEY,
            configFingerprint: ctx.twelveFingerprint,
            globalCacheDisabled: ctx.globalCacheDisabled,
            globalCacheRoot: ctx.globalCacheRoot,
            dailyQuotaTracker: ctx.dailyQuotaTracker,
            gptUsageTracker: ctx.gptUsageTracker,
            batchId: ctx.resolvedBatchId,
          });
        }

        return clipResult;
      },
      { limit: waveALimit, label: "analysis-wave-a" },
    );

    const waveStep = ctx.runTranscribe
      ? "transcribe"
      : (ctx.runAudio ? "audio_analysis" : "twelvelabs");
    const waveAResults = assertWaveSuccess(waveStep, waveAOutput, ctx.resolvedBatchId, ledger);

    if (ctx.runTranscribe) {
      ledger?.finishStep("transcribe", "succeeded");
      result.words = waveAResults.map((entry) => entry.words).filter(Boolean);
    }
    if (ctx.runMetaCommands) {
      result.metaCommands = await runMetaCommandsStepTracked(ctx, ledger, result.words);
    }
    if (ctx.runAudio) {
      ledger?.beginStep("audio_analysis");
      let perClipAnalysis = waveAResults.map((entry) => entry.audio).filter(Boolean);
      const deliveryOutput = await runClipWave(
        ctx.clips.map((clip, index) => ({
          clip,
          audio: waveAResults[index]?.audio,
          words: waveAResults[index]?.words ?? loadWordsForClip(ctx.workDir, clip),
        })),
        async ({ clip, audio, words }) => {
          if (!audio || !words?.words?.length) {
            return audio;
          }
          return enrichClipWithDeliveryAnalysis(audio, {
            workDir: ctx.workDir,
            clip,
            words,
            stub: ctx.audioStub,
          });
        },
        { limit: getClipConcurrencyLimit(), label: "delivery_analysis" },
      );
      perClipAnalysis = assertWaveSuccess("audio_analysis", deliveryOutput, ctx.resolvedBatchId, ledger)
        .filter(Boolean);
      result.audioIndex = buildAudioIndexFromAnalyses(ctx.workDir, ctx.catalog, perClipAnalysis, { force: ctx.force });
      ledger?.finishStep("audio_analysis", "succeeded");
    }
    if (ctx.runTwelve) {
      ledger?.finishStep("twelvelabs", "succeeded");
      result.twelvelabs = waveAResults.map((entry) => entry.twelve).filter(Boolean);
    }
  } else {
    result.words = await runTranscribeWave(ctx, ledger);
    result.metaCommands = await runMetaCommandsStepTracked(ctx, ledger, result.words);
    result.audioIndex = await runAudioWaveAndIndex(ctx, ledger, result.words);
    result.twelvelabs = await runTwelveLabsWave(ctx, ledger);
  }

  result.keyframes = await runKeyframesWave(ctx, ledger, waveOptions);

  if (parallelGpuSteps) {
    const gpuResult = await runParallelGpuWave(ctx, ledger);
    result.vision = gpuResult.vision;
    result.objects = gpuResult.objects;
  } else {
    result.vision = await runVisionWave(ctx, ledger);
    result.objects = await runObjectsWave(ctx, ledger);
  }

  return result;
}

/**
 * Default: one analysis step type at a time (transcribe → meta → audio → twelvelabs → keyframes → vision → objects).
 * Opt-in parallelism via ANALYSIS_PARALLEL_CLIPS / ANALYSIS_PARALLEL_GPU_STEPS.
 */
export async function runAnalysisPhase({
  workDir,
  fromStep,
  toStep,
  twelvelabsEnabled = true,
  apiKey,
  audioStub = false,
  visionStub = false,
  objectsEnabled = true,
  objectsStub = false,
  twelvelabsStub,
  extractKeyframes = true,
  force = false,
  globalCacheDisabled = false,
  globalCacheRoot,
  extractFrameAtFn,
  dailyQuotaTracker = null,
  batchId = null,
  gptUsageTracker = null,
  ledger = null,
}) {
  const ctx = buildAnalysisContext({
    workDir,
    fromStep,
    toStep,
    twelvelabsEnabled,
    apiKey,
    audioStub,
    visionStub,
    objectsEnabled,
    objectsStub,
    twelvelabsStub,
    force,
    globalCacheDisabled,
    globalCacheRoot,
    dailyQuotaTracker,
    batchId,
    gptUsageTracker,
  });

  const waveOptions = { extractKeyframes, extractFrameAtFn };
  const parallelClips = isAnalysisParallelClips();
  const parallelGpuSteps = isAnalysisParallelGpuSteps();

  if (parallelClips || parallelGpuSteps) {
    return runAnalysisPhaseWaves(ctx, ledger, waveOptions, { parallelClips, parallelGpuSteps });
  }

  return runAnalysisPhaseSequential(ctx, ledger, waveOptions);
}
