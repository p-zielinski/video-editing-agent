import fs from "node:fs";
import path from "node:path";
import {
  getAudioConcurrencyLimit,
  getClipConcurrencyLimit,
  getGpuConcurrencyLimit,
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

/**
 * Wave A: transcribe + audio_analysis + twelvelabs (per clip, in parallel).
 * Wave B: keyframes per clip.
 * Wave C: vision + objects per clip (in parallel).
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

  async function runTrackedAnalysisStep(step, enabled, fn) {
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

  const result = {
    words: null,
    metaCommands: null,
    audioIndex: null,
    keyframes: null,
    twelvelabs: null,
    vision: null,
    objects: null,
  };

  if (runTranscribe || runAudio || runTwelve) {
    const expectedTerms = Array.isArray(manifest?.batchContext?.expectedTerms)
      ? manifest.batchContext.expectedTerms
      : [];
    const wordsFingerprint = buildStepConfigFingerprint("words", { expectedTerms });
    const resolvedTwelveKey = apiKey ?? process.env.TWELVELABS_API_KEY;
    const useTwelveStub = twelvelabsStub ?? !resolvedTwelveKey;
    const twelveFingerprint = buildStepConfigFingerprint("twelvelabs", {
      useStub: useTwelveStub,
      twelvelabsLive: !useTwelveStub,
    });

    const waveALimit = runAudio
      ? Math.min(getClipConcurrencyLimit(), getAudioConcurrencyLimit())
      : getClipConcurrencyLimit();

    if (runTranscribe) {
      ledger?.beginStep("transcribe");
    }
    if (runTwelve) {
      ledger?.beginStep("twelvelabs");
    }
    const waveAOutput = await runClipWave(
      clips,
      async (clip) => {
        const clipResult = {};

        if (runTranscribe) {
          clipResult.words = await transcribeClip({
            workDir,
            clip,
            apiKey,
            force,
            globalCacheDisabled,
            manifest,
            configFingerprint: wordsFingerprint,
            dailyQuotaTracker,
            batchId: resolvedBatchId,
            gptUsageTracker,
          });
        }

        if (runAudio) {
          clipResult.audio = await analyzeClipAudio({
            workDir,
            clip,
            manifest,
            stub: audioStub,
            force,
            globalCacheDisabled,
          });
        }

        if (runTwelve) {
          clipResult.twelve = await processClipTwelveLabs({
            workDir,
            clip,
            manifest,
            useStub: useTwelveStub,
            force,
            apiKey: resolvedTwelveKey,
            configFingerprint: twelveFingerprint,
            globalCacheDisabled,
            globalCacheRoot,
          });
        }

        return clipResult;
      },
      { limit: waveALimit, label: "analysis-wave-a" },
    );

    const waveStep = runTranscribe
      ? "transcribe"
      : (runAudio ? "audio_analysis" : "twelvelabs");
    const waveAResults = assertWaveSuccess(waveStep, waveAOutput, resolvedBatchId, ledger);
    if (runTranscribe) {
      ledger?.finishStep("transcribe", "succeeded");
      result.words = waveAResults.map((entry) => entry.words).filter(Boolean);
    }
    if (runMetaCommands) {
      result.metaCommands = await runTrackedAnalysisStep("meta_commands", true, () => runMetaCommandsStep({
        workDir,
        force,
        wordsByClip: result.words,
      }));
    }
    if (runAudio) {
      ledger?.beginStep("audio_analysis");
      let perClipAnalysis = waveAResults.map((entry) => entry.audio).filter(Boolean);
      const deliveryOutput = await runClipWave(
        clips.map((clip, index) => ({
          clip,
          audio: waveAResults[index]?.audio,
          words: waveAResults[index]?.words
            ?? (() => {
              const wordsPath = path.join(workDir, ARTIFACTS.words(clip.clipId));
              return fs.existsSync(wordsPath) ? readJson(wordsPath) : null;
            })(),
        })),
        async ({ clip, audio, words }) => {
          if (!audio || !words?.words?.length) {
            return audio;
          }
          return enrichClipWithDeliveryAnalysis(audio, {
            workDir,
            clip,
            words,
            stub: audioStub,
          });
        },
        { limit: getClipConcurrencyLimit(), label: "delivery_analysis" },
      );
      perClipAnalysis = assertWaveSuccess("audio_analysis", deliveryOutput, resolvedBatchId, ledger)
        .filter(Boolean);
      result.audioIndex = buildAudioIndexFromAnalyses(workDir, catalog, perClipAnalysis, { force });
      ledger?.finishStep("audio_analysis", "succeeded");
    }
    if (runTwelve) {
      ledger?.finishStep("twelvelabs", "succeeded");
      result.twelvelabs = waveAResults.map((entry) => entry.twelve).filter(Boolean);
    }
  } else if (runMetaCommands) {
    result.metaCommands = await runTrackedAnalysisStep("meta_commands", true, () => runMetaCommandsStep({ workDir, force }));
  }

  if (runKf) {
    ledger?.beginStep("keyframes");
    const clipRegistry = loadClipRegistryEntries(workDir);
    const keyframesOutput = await runClipWave(
      clips,
      (clip) => processClipKeyframes({
        workDir,
        clip,
        catalog,
        manifest,
        clipRegistry,
        extractImages: extractKeyframes,
        force,
        globalCacheDisabled,
        globalCacheRoot,
        extractFrameAtFn,
      }),
      { limit: getClipConcurrencyLimit(), label: "analysis-wave-b" },
    );
    result.keyframes = assertWaveSuccess("keyframes", keyframesOutput, resolvedBatchId, ledger);
    ledger?.finishStep("keyframes", "succeeded");
  }

  if (runVision || runObjects) {
    if (runVision) {
      ledger?.beginStep("vision");
    }
    if (runObjects) {
      ledger?.beginStep("objects");
    }
    const visionFingerprint = buildStepConfigFingerprint("vision", { stub: visionStub });
    const objectsFingerprint = buildStepConfigFingerprint("objects", {
      stub: objectsStub,
      enabled: objectsEnabled,
    });

    const waveCOutput = await runClipWave(
      clips,
      async (clip) => {
        const clipResult = {};
        const tasks = [];

        if (runVision) {
          tasks.push(
            processClipVision({
              workDir,
              clip,
              manifest,
              stub: visionStub,
              force,
              globalCacheDisabled,
              globalCacheRoot,
              configFingerprint: visionFingerprint,
            }).then((vision) => {
              clipResult.vision = vision;
            }),
          );
        }

        if (runObjects) {
          tasks.push(
            processClipObjects({
              workDir,
              clip,
              manifest,
              stub: objectsStub,
              force,
              globalCacheDisabled,
              globalCacheRoot,
              configFingerprint: objectsFingerprint,
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

    const waveCStep = runVision ? "vision" : "objects";
    const waveCResults = assertWaveSuccess(waveCStep, waveCOutput, resolvedBatchId, ledger);

    if (runVision) {
      result.vision = waveCResults.map((entry) => entry.vision).filter(Boolean);
      ledger?.finishStep("vision", "succeeded");
    }
    if (runObjects) {
      result.objects = waveCResults.map((entry) => entry.objects).filter(Boolean);
      ledger?.finishStep("objects", "succeeded");
    }
  }

  return result;
}
