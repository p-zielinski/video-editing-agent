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
import { ERROR_CODES } from "../../lib/recovery/error-codes.js";
import { StepFailureError } from "../../lib/recovery/errors.js";
import { classifyError } from "../../lib/recovery/classify-error.js";

export function enhancedAudioPath(workDir, clipId) {
  return path.join(workDir, "enhanced-audio", `${clipId}.wav`);
}

export function audioEnhancementManifestPath(workDir, clipId) {
  return path.join(workDir, ARTIFACTS.audioEnhancementManifest(clipId));
}

/**
 * True when every timeline use of clipId is on a preserveAmbientAudio segment.
 */
export function clipOnlyUsedOnPreserveAmbient(recipe, clipId) {
  let seen = false;
  for (const output of recipe?.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      const audioClipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (audioClipId !== clipId) {
        continue;
      }
      seen = true;
      if (segment.preserveAmbientAudio !== true) {
        return false;
      }
    }
  }
  return seen;
}

function collectAcceptedDecisions(recipe) {
  return (recipe.audioEnhancementDecisions ?? []).filter(
    (decision) => (
      decision.action === "accept"
      && !clipOnlyUsedOnPreserveAmbient(recipe, decision.clipId)
    ),
  );
}

const ARTIFACT_MISSING_REASON_RE = /brak (udanego )?artefaktu|bez udanego artefaktu/i;

function findPerClipAnalysis(perClipAnalysis, clipId) {
  if (!perClipAnalysis) {
    return null;
  }
  if (Array.isArray(perClipAnalysis)) {
    return perClipAnalysis.find((entry) => entry.clipId === clipId) ?? null;
  }
  if (typeof perClipAnalysis === "object") {
    return perClipAnalysis[clipId] ?? null;
  }
  return null;
}

function resolveRepairOnlyPolishPreset(analysis) {
  const humScore = analysis?.audioQuality?.humScore ?? 0;
  const windScore = analysis?.audioQuality?.windScore ?? 0;
  if (humScore > 0.5 && windScore < 0.45) {
    return "repair_only";
  }
  return null;
}

/**
 * Align recipe decisions with an existing enhancement index (succeeded/stubbed clips).
 * @param {object} recipe
 * @param {object} enhancementIndex
 * @param {{ perClipAnalysis?: object[] }} [options]
 * @returns {object} recipe
 */
export function reconcileAudioEnhancementDecisions(
  recipe,
  enhancementIndex,
  { perClipAnalysis = null } = {},
) {
  const succeededClips = (enhancementIndex?.clips ?? []).filter(
    (entry) => entry.status === "succeeded" || entry.status === "stubbed",
  );
  if (!succeededClips.length) {
    return recipe;
  }

  const decisions = [...(recipe.audioEnhancementDecisions ?? [])];
  const byClipId = new Map(decisions.map((decision) => [decision.clipId, decision]));

  for (const manifest of succeededClips) {
    const { clipId } = manifest;
    const analysis = findPerClipAnalysis(perClipAnalysis, clipId);
    const repairOnlyPreset = resolveRepairOnlyPolishPreset(analysis);
    let decision = byClipId.get(clipId);

    if (!decision) {
      decision = {
        candidateId: manifest.candidateId,
        clipId,
        action: "accept",
        dialogueValue: "useful",
        reason: "Zgodne z istniejącym artefaktem audio_enhancement",
        providerPreference: "auto",
        targetDialogueLufs: -18,
        retranscribePolicy: "if_material_improvement",
        ...(repairOnlyPreset ? { polishPreset: repairOnlyPreset } : {}),
      };
      decisions.push(decision);
      byClipId.set(clipId, decision);
      continue;
    }

    // Only flip artifact-missing rejects (fixer contract). Never override
    // intentional ambient / director rejects when an old enhanced artifact exists.
    const hasArtifactMissingReason = ARTIFACT_MISSING_REASON_RE.test(decision.reason ?? "");
    if (hasArtifactMissingReason) {
      decision.action = "accept";
      decision.reason = "Zgodne z istniejącym artefaktem audio_enhancement (reconciled)";
      if (!decision.candidateId) {
        decision.candidateId = manifest.candidateId;
      }
    }

    if (decision.action === "accept" && repairOnlyPreset) {
      decision.polishPreset = repairOnlyPreset;
    }
  }

  recipe.audioEnhancementDecisions = decisions;
  return recipe;
}

function collectSucceededManifests(enhancementIndex) {
  return (enhancementIndex?.clips ?? []).filter(
    (entry) => entry.status === "succeeded" || entry.status === "stubbed",
  );
}

function applySourceVolumeDbToRecipe(recipe, clipId, sourceVolumeDb) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio === true) {
        continue;
      }
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

function buildFailedManifest({
  decision,
  clipId,
  config,
  error,
  attemptedProvider = null,
}) {
  const classified = classifyError(error, { step: "audio_enhancement" });
  return AudioEnhancementManifestSchema.parse({
    version: "1.0",
    candidateId: decision.candidateId,
    clipId,
    status: "failed",
    provider: attemptedProvider ?? config.provider,
    attemptedProvider: attemptedProvider ?? config.provider,
    errorCode: classified.code ?? ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED,
    failureCause: classified.cause ?? classified.message,
    warnings: [error instanceof Error ? error.message : String(error)],
  });
}

function writeEnhancementIndex(workDir, catalog, manifests, recipe, { perClipAnalysis = null } = {}) {
  const index = AudioEnhancementIndexSchema.parse({
    version: "1.0",
    batchId: catalog.batchId,
    clips: manifests,
  });
  reconcileAudioEnhancementDecisions(recipe, index, { perClipAnalysis });
  writeJson(path.join(workDir, ARTIFACTS.audioEnhancementIndex), index);
  materializeSourceVolumeDb(recipe, index);
  writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
  return index;
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

  try {
    if (!fs.existsSync(analysisPath)) {
      await extractAudioForAnalysis(clip.sourcePath, analysisPath);
    }

    const before = await measureQualityMetrics(analysisPath, null);
    const rawOutputPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.raw.wav`);

    const providerResult = await runEnhancementProvider({
      inputPath: analysisPath,
      outputPath: rawOutputPath,
      config,
      providerPreference: decision.providerPreference ?? "auto",
      clipId: clip.clipId,
    });

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
  } catch (error) {
    const failed = buildFailedManifest({
      decision,
      clipId: clip.clipId,
      config,
      error,
      attemptedProvider: error?.provider ?? config.provider,
    });
    writeJson(manifestPath, failed);
    if (config.required) {
      throw error;
    }
    return failed;
  }
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

  const catalog = readJson(path.join(workDir, ARTIFACTS.sceneCatalog));
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  const existingIndex = fs.existsSync(indexPath) ? readJson(indexPath) : null;

  if (!force && shouldUseCachedArtifact(workDir, ARTIFACTS.audioEnhancementIndex, force)) {
    const recipe = EditRecipeV2Schema.parse(readJson(recipePath));
    reconcileAudioEnhancementDecisions(recipe, existingIndex, { perClipAnalysis });
    materializeSourceVolumeDb(recipe, existingIndex);
    writeJson(recipePath, recipe);
    return existingIndex;
  }

  const recipe = EditRecipeV2Schema.parse(readJson(recipePath));
  const accepted = collectAcceptedDecisions(recipe);
  const existingSucceeded = collectSucceededManifests(existingIndex);

  if (!accepted.length && existingSucceeded.length > 0) {
    reconcileAudioEnhancementDecisions(recipe, existingIndex, { perClipAnalysis });
    materializeSourceVolumeDb(recipe, existingIndex);
    writeJson(recipePath, recipe);
    return AudioEnhancementIndexSchema.parse(existingIndex);
  }

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

  const index = writeEnhancementIndex(workDir, catalog, manifests, recipe, { perClipAnalysis });

  const failedManifests = manifests.filter((entry) => entry.status === "failed");
  if (failedManifests.length > 0) {
    throw new StepFailureError(
      `audio_enhancement: ${failedManifests.length} klip(ów) nie powiodło się`,
      {
        code: ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED,
        step: "audio_enhancement",
        failures: failedManifests.map((entry) => ({
          clipId: entry.clipId,
          code: entry.errorCode ?? ERROR_CODES.AUDIO_ENHANCEMENT_CLIP_FAILED,
          message: entry.failureCause ?? entry.warnings?.[0] ?? `Enhancement failed for ${entry.clipId}`,
          scope: { clipId: entry.clipId },
        })),
      },
    );
  }

  return index;
}

export function loadAudioEnhancementIndex(workDir) {
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  return readJson(indexPath);
}
