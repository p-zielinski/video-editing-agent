import fs from "node:fs";
import path from "node:path";
import {
  getClipConcurrencyLimit,
  getGpuConcurrencyLimit,
  runWithConcurrency,
} from "../lib/clip-concurrency.js";
import { buildStepConfigFingerprint } from "../lib/config-fingerprint.js";
import { readJson, ARTIFACTS, shouldRunStep } from "./work-paths.js";
import { transcribeClip } from "./steps/transcribe.js";
import { runMetaCommandsStep } from "./steps/meta-commands.js";
import { analyzeClipAudio, buildAudioIndexFromAnalyses } from "./steps/audio-analysis.js";
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

    const waveAResults = await runWithConcurrency(
      clips,
      async (clip) => {
        const clipResult = {};
        const tasks = [];

        if (runTranscribe) {
          tasks.push(
            transcribeClip({
              workDir,
              clip,
              apiKey,
              force,
              globalCacheDisabled,
              manifest,
              configFingerprint: wordsFingerprint,
            }).then((words) => {
              clipResult.words = words;
            }),
          );
        }

        if (runAudio) {
          tasks.push(
            analyzeClipAudio({
              workDir,
              clip,
              manifest,
              stub: audioStub,
              force,
              globalCacheDisabled,
            }).then((audio) => {
              clipResult.audio = audio;
            }),
          );
        }

        if (runTwelve) {
          tasks.push(
            processClipTwelveLabs({
              workDir,
              clip,
              manifest,
              useStub: useTwelveStub,
              force,
              apiKey: resolvedTwelveKey,
              configFingerprint: twelveFingerprint,
              globalCacheDisabled,
              globalCacheRoot,
            }).then((twelve) => {
              clipResult.twelve = twelve;
            }),
          );
        }

        await Promise.all(tasks);
        return clipResult;
      },
      { limit: getClipConcurrencyLimit(), label: "analysis-wave-a" },
    );

    if (runTranscribe) {
      result.words = waveAResults.map((entry) => entry.words).filter(Boolean);
    }
    if (runMetaCommands) {
      result.metaCommands = await runMetaCommandsStep({
        workDir,
        force,
        wordsByClip: result.words,
      });
    }
    if (runAudio) {
      const perClipAnalysis = waveAResults.map((entry) => entry.audio).filter(Boolean);
      result.audioIndex = buildAudioIndexFromAnalyses(workDir, catalog, perClipAnalysis, { force });
    }
    if (runTwelve) {
      result.twelvelabs = waveAResults.map((entry) => entry.twelve).filter(Boolean);
    }
  } else if (runMetaCommands) {
    result.metaCommands = await runMetaCommandsStep({ workDir, force });
  }

  if (runKf) {
    const clipRegistry = loadClipRegistryEntries(workDir);
    result.keyframes = await runWithConcurrency(
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
  }

  if (runVision || runObjects) {
    const visionFingerprint = buildStepConfigFingerprint("vision", { stub: visionStub });
    const objectsFingerprint = buildStepConfigFingerprint("objects", {
      stub: objectsStub,
      enabled: objectsEnabled,
    });

    const waveCResults = await runWithConcurrency(
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

    if (runVision) {
      result.vision = waveCResults.map((entry) => entry.vision).filter(Boolean);
    }
    if (runObjects) {
      result.objects = waveCResults.map((entry) => entry.objects).filter(Boolean);
    }
  }

  return result;
}
