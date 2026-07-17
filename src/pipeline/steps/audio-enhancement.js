import path from "node:path";
import fs from "node:fs";
import { extractAudioForAnalysis, analysisAudioPath } from "../../lib/extract-audio.js";
import { measureLoudness } from "../../lib/measure-loudness.js";
import { resolveAudioEnhancementConfig } from "../../lib/audio-enhancement/config.js";
import { runEnhancementProvider } from "../../lib/audio-enhancement/providers/index.js";
import {
  applyLoudnessNormalization,
  clampGainDb,
  resolveTargetDialogueLufs,
} from "../../lib/audio-enhancement/normalize.js";
import {
  applyDspPolish,
  resolvePolishPreset,
  shouldSkipPolishForWind,
} from "../../lib/audio-enhancement/dsp-polish.js";
import { runPythonScript } from "../../lib/python-bridge.js";
import { EditRecipeV2Schema } from "../../schemas/edit-recipe-v2.js";
import {
  AudioEnhancementIndexSchema,
  AudioEnhancementManifestSchema,
} from "../../schemas/audio-enhancement.js";
import { readJson, writeJson, ARTIFACTS } from "../work-paths.js";
import { shouldUseCachedArtifact } from "../artifact-deps.js";
import { loadPerClipAudioAnalysisForCatalog } from "./audio-analysis.js";

export function enhancedAudioPath(workDir, clipId) {
  return path.join(workDir, "enhanced-audio", `${clipId}.wav`);
}

export function audioEnhancementManifestPath(workDir, clipId) {
  return path.join(workDir, ARTIFACTS.audioEnhancementManifest(clipId));
}

function collectAcceptedDecisions(recipe) {
  return (recipe.audioEnhancementDecisions ?? []).filter(
    (decision) => decision.action === "accept",
  );
}

function applySourceVolumeDbToRecipe(recipe, clipId, sourceVolumeDb) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const audioClipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (audioClipId === clipId) {
        segment.sourceVolumeDb = sourceVolumeDb;
      }
    }
  }
}

async function measureQualityMetrics(audioPath, voiceLufs) {
  const quality = await runPythonScript("audio_quality.py", {
    audioPath,
    voiceLufs,
    stub: false,
  });
  const loudness = await measureLoudness(audioPath, { targetLufs: -18 }).catch(() => null);
  return {
    integratedLufs: loudness?.integratedLufs ?? null,
    estimatedSnrDb: quality.estimatedSnrDb ?? null,
    qualityScore: quality.qualityScore ?? null,
  };
}

export async function enhanceClipAudio({
  workDir,
  clip,
  decision,
  config,
  perClipAnalysis = null,
  force = false,
}) {
  const manifestPath = audioEnhancementManifestPath(workDir, clip.clipId);
  if (!force && fs.existsSync(manifestPath)) {
    const existing = readJson(manifestPath);
    if (existing.candidateId === decision.candidateId && existing.status !== "failed") {
      return AudioEnhancementManifestSchema.parse(existing);
    }
  }

  const outputPath = enhancedAudioPath(workDir, clip.clipId);
  const analysisPath = analysisAudioPath(workDir, clip.clipId);
  if (!fs.existsSync(analysisPath)) {
    await extractAudioForAnalysis(clip.sourcePath, analysisPath);
  }

  const before = await measureQualityMetrics(analysisPath, null);
  const rawOutputPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.raw.wav`);

  let providerResult;
  try {
    providerResult = await runEnhancementProvider({
      inputPath: analysisPath,
      outputPath: rawOutputPath,
      config,
      providerPreference: decision.providerPreference ?? "auto",
    });
  } catch (error) {
    const failed = AudioEnhancementManifestSchema.parse({
      version: "1.0",
      candidateId: decision.candidateId,
      clipId: clip.clipId,
      status: "failed",
      provider: config.provider,
      warnings: [error.message],
    });
    writeJson(manifestPath, failed);
    if (config.required) {
      throw error;
    }
    return failed;
  }

  const afterRaw = await measureQualityMetrics(rawOutputPath, null);
  const goodLufs = [];
  const targetLufs = resolveTargetDialogueLufs(decision, goodLufs);

  let loudnormInputPath = rawOutputPath;
  let dspChainApplied = null;
  const polishPreset = decision.polishPreset ?? "none";
  const polishFilter = resolvePolishPreset(decision);

  if (
    polishPreset !== "none"
    && polishFilter
    && !shouldSkipPolishForWind(perClipAnalysis, clip.clipId)
  ) {
    const polishedPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.polished.wav`);
    const presetKey = polishPreset === "repair_only" ? "repair_only" : "engagement_polish";
    await applyDspPolish(rawOutputPath, polishedPath, presetKey);
    loudnormInputPath = polishedPath;
    dspChainApplied = presetKey;
  }

  const normalization = await applyLoudnessNormalization(loudnormInputPath, outputPath, targetLufs);
  const sourceVolumeDb = clampGainDb(normalization.gainDb);

  const manifest = AudioEnhancementManifestSchema.parse({
    version: "1.0",
    candidateId: decision.candidateId,
    clipId: clip.clipId,
    status: providerResult.status === "stubbed" ? "stubbed" : "succeeded",
    provider: providerResult.provider,
    model: providerResult.model,
    outputPath: path.relative(workDir, outputPath),
    before,
    afterRaw,
    normalization: {
      targetLufs,
      gainDb: normalization.gainDb,
      finalIntegratedLufs: normalization.finalIntegratedLufs,
    },
    sourceVolumeDb,
    ...(dspChainApplied ? { dspChainApplied } : {}),
    warnings: [],
  });

  writeJson(manifestPath, manifest);
  if (fs.existsSync(rawOutputPath)) {
    fs.unlinkSync(rawOutputPath);
  }
  const polishedPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.polished.wav`);
  if (fs.existsSync(polishedPath)) {
    fs.unlinkSync(polishedPath);
  }
  return manifest;
}

export function materializeSourceVolumeDb(recipe, enhancementIndex) {
  const byClip = new Map(
    (enhancementIndex?.clips ?? [])
      .filter((entry) => entry.status === "succeeded" || entry.status === "stubbed")
      .map((entry) => [entry.clipId, entry.sourceVolumeDb ?? 0]),
  );

  for (const [clipId, sourceVolumeDb] of byClip.entries()) {
    applySourceVolumeDbToRecipe(recipe, clipId, sourceVolumeDb);
  }
  return recipe;
}

export async function runAudioEnhancementStep({
  workDir,
  force = false,
  config = resolveAudioEnhancementConfig(),
}) {
  const recipePath = path.join(workDir, ARTIFACTS.recipeDraft);
  if (!fs.existsSync(recipePath)) {
    throw new Error(`Brak ${ARTIFACTS.recipeDraft} — uruchom direct przed audio_enhancement`);
  }

  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (!force && shouldUseCachedArtifact(workDir, ARTIFACTS.audioEnhancementIndex, force)) {
    const existing = readJson(indexPath);
    const recipe = EditRecipeV2Schema.parse(readJson(recipePath));
    materializeSourceVolumeDb(recipe, existing);
    writeJson(recipePath, recipe);
    return existing;
  }

  const recipe = EditRecipeV2Schema.parse(readJson(recipePath));
  const accepted = collectAcceptedDecisions(recipe);
  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const manifests = [];

  for (const decision of accepted) {
    const clip = catalog.clips.find((entry) => entry.clipId === decision.clipId);
    if (!clip) {
      manifests.push(AudioEnhancementManifestSchema.parse({
        version: "1.0",
        candidateId: decision.candidateId,
        clipId: decision.clipId,
        status: "skipped",
        provider: config.provider,
        warnings: ["clip_not_found"],
      }));
      continue;
    }

    const manifest = await enhanceClipAudio({
      workDir,
      clip,
      decision,
      config,
      perClipAnalysis,
      force,
    });
    manifests.push(manifest);
  }

  const index = AudioEnhancementIndexSchema.parse({
    version: "1.0",
    batchId: catalog.batchId,
    clips: manifests,
  });
  writeJson(indexPath, index);
  materializeSourceVolumeDb(recipe, index);
  writeJson(recipePath, recipe);
  return index;
}

export function loadAudioEnhancementIndex(workDir) {
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  return readJson(indexPath);
}
