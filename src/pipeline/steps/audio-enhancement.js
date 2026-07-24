import path from "node:path";
import fs from "node:fs";
import {
  extractAudioForEnhancement,
  enhancementInputAudioPath,
  alignAudioDuration,
} from "../../lib/extract-audio.js";
import { probeDuration } from "../../lib/ffmpeg.js";
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
 * Prefer successful enhanced WAV for Whisper when present; else null (caller uses source).
 * Enhanced WAV is pad/trimmed to source duration so word timings stay on the source timeline.
 */
export function resolveEnhancedAudioForWhisper(workDir, clipId) {
  const wavPath = enhancedAudioPath(workDir, clipId);
  if (!fs.existsSync(wavPath)) {
    return null;
  }

  const manifestPath = audioEnhancementManifestPath(workDir, clipId);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      if (manifest.status !== "succeeded" && manifest.status !== "stubbed") {
        return null;
      }
    } catch {
      return null;
    }
  }

  return wavPath;
}

/**
 * Resolve media path for Whisper extract: enhanced WAV if available, else clip source.
 */
export function resolveWhisperMediaPath(workDir, clip) {
  return resolveEnhancedAudioForWhisper(workDir, clip.clipId) ?? clip.sourcePath;
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

function buildEnhanceAllDecision(clipId) {
  return {
    candidateId: `enh_${clipId}`,
    clipId,
    action: "accept",
    dialogueValue: "useful",
    reason: "enhance_all_pre_whisper",
    providerPreference: "auto",
    targetDialogueLufs: -18,
    retranscribePolicy: "if_material_improvement",
  };
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

function applySourceVolumeDbToRecipe(recipe, clipId) {
  for (const output of recipe.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio === true) {
        continue;
      }
      const audioClipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (audioClipId === clipId) {
        // Gain is baked into the loudnormed enhanced WAV — do not double-apply at render.
        segment.sourceVolumeDb = 0;
      }
    }
  }
}

async function measureQualityMetrics(audioPath, voiceLufs) {
  const quality = await runPythonScript("audio_quality.py", {
    audioPath,
    voiceLufs,
    stub: false,
  }).catch(() => ({}));
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

function writeEnhancementIndex(workDir, catalog, manifests, recipe = null, { perClipAnalysis = null } = {}) {
  const index = AudioEnhancementIndexSchema.parse({
    version: "1.0",
    batchId: catalog.batchId,
    clips: manifests,
  });
  writeJson(path.join(workDir, ARTIFACTS.audioEnhancementIndex), index);
  if (recipe) {
    reconcileAudioEnhancementDecisions(recipe, index, { perClipAnalysis });
    materializeSourceVolumeDb(recipe, index);
    writeJson(path.join(workDir, ARTIFACTS.recipeDraft), recipe);
  }
  return index;
}

function catalogClipsAlreadyEnhanced(catalog, existingIndex, workDir) {
  const succeeded = new Map(
    collectSucceededManifests(existingIndex).map((entry) => [entry.clipId, entry]),
  );
  if (!catalog?.clips?.length) {
    return { complete: false, manifests: [] };
  }
  const manifests = [];
  for (const clip of catalog.clips) {
    const existing = succeeded.get(clip.clipId);
    if (!existing || !fs.existsSync(enhancedAudioPath(workDir, clip.clipId))) {
      return { complete: false, manifests: [] };
    }
    manifests.push(existing);
  }
  return { complete: true, manifests };
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
    // Phase 3: reuse any non-failed artifact for Whisper; candidateId may differ
    // between enhance-all and later recipe accept metadata.
    if (existing.status !== "failed") {
      const wavPath = enhancedAudioPath(workDir, clip.clipId);
      if (fs.existsSync(wavPath)) {
        return AudioEnhancementManifestSchema.parse(existing);
      }
    }
  }

  const outputPath = enhancedAudioPath(workDir, clip.clipId);
  const enhancementInputPath = enhancementInputAudioPath(workDir, clip.clipId);

  try {
    if (!fs.existsSync(enhancementInputPath)) {
      await extractAudioForEnhancement(clip.sourcePath, enhancementInputPath);
    }

    const before = await measureQualityMetrics(enhancementInputPath, null);
    const rawOutputPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.raw.wav`);

    const providerResult = await runEnhancementProvider({
      inputPath: enhancementInputPath,
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

    const loudnormPath = path.join(workDir, "enhanced-audio", `${clip.clipId}.loudnorm.wav`);
    const normalization = await applyLoudnessNormalization(loudnormInputPath, loudnormPath, targetLufs);
    const sourceVolumeDb = clampGainDb(normalization.gainDb);

    const sourceDurationSec = Number.isFinite(clip.durationSec) && clip.durationSec > 0
      ? clip.durationSec
      : await probeDuration(clip.sourcePath);
    const { durationDeltaMs, aligned } = await alignAudioDuration(
      loudnormPath,
      outputPath,
      sourceDurationSec,
    );

    const warnings = [];
    if (aligned) {
      warnings.push(
        `duration_aligned: enhanced audio pad/trimmed to source ${sourceDurationSec.toFixed(3)}s `
        + `(delta ${durationDeltaMs}ms) for Whisper/render timeline alignment`,
      );
    }

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
      durationDeltaMs,
      ...(dspChainApplied ? { dspChainApplied } : {}),
      warnings,
    });

    writeJson(manifestPath, manifest);
    for (const tempName of [
      rawOutputPath,
      loudnormPath,
      path.join(workDir, "enhanced-audio", `${clip.clipId}.polished.wav`),
    ]) {
      if (fs.existsSync(tempName)) {
        fs.unlinkSync(tempName);
      }
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
  const enhancedClipIds = (enhancementIndex?.clips ?? [])
    .filter((entry) => entry.status === "succeeded" || entry.status === "stubbed")
    .map((entry) => entry.clipId);

  for (const clipId of enhancedClipIds) {
    applySourceVolumeDbToRecipe(recipe, clipId);
  }
  return recipe;
}

const ENHANCEMENT_MANIFEST_RE = /^07a-audio-enhancement-(.+)\.json$/;

/**
 * Rebuild enhancement index from per-clip manifests when the index file is missing.
 */
export function rebuildEnhancementIndexFromDisk(workDir, catalog) {
  if (!fs.existsSync(workDir)) {
    return null;
  }

  const manifests = [];
  for (const fileName of fs.readdirSync(workDir)) {
    const match = fileName.match(ENHANCEMENT_MANIFEST_RE);
    if (!match) {
      continue;
    }

    const manifestPath = path.join(workDir, fileName);
    let manifest;
    try {
      manifest = AudioEnhancementManifestSchema.parse(readJson(manifestPath));
    } catch {
      continue;
    }

    if (manifest.status !== "succeeded" && manifest.status !== "stubbed") {
      continue;
    }

    const wavPath = enhancedAudioPath(workDir, manifest.clipId);
    if (!fs.existsSync(wavPath)) {
      continue;
    }

    manifests.push(manifest);
  }

  if (!manifests.length) {
    return null;
  }

  return AudioEnhancementIndexSchema.parse({
    version: "1.0",
    batchId: catalog?.batchId ?? "unknown",
    clips: manifests,
  });
}

function resolveEnhancementIndex(workDir, catalog) {
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (fs.existsSync(indexPath)) {
    return readJson(indexPath);
  }
  return rebuildEnhancementIndexFromDisk(workDir, catalog);
}

function maybeReconcileRecipe(workDir, recipePath, existingIndex, perClipAnalysis) {
  if (!fs.existsSync(recipePath) || !existingIndex) {
    return;
  }
  const recipe = EditRecipeV2Schema.parse(readJson(recipePath));
  reconcileAudioEnhancementDecisions(recipe, existingIndex, { perClipAnalysis });
  materializeSourceVolumeDb(recipe, existingIndex);
  writeJson(recipePath, recipe);
}

async function enhanceDecisions({
  workDir,
  catalog,
  decisions,
  config,
  perClipAnalysis,
  force,
  recipe = null,
}) {
  const manifests = [];

  for (const decision of decisions) {
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

/**
 * Pre-Whisper: denoise ALL catalog clips.
 * Recipe accept/reject gates render use (and supplies polish metadata), not materialization.
 * When artifacts already exist for every catalog clip → reuse / reconcile no-op.
 */
export async function runAudioEnhancementStep({
  workDir,
  force = false,
  config = resolveAudioEnhancementConfig(),
}) {
  const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Brak ${ARTIFACTS.sceneCatalog} — uruchom ingest przed audio_enhancement`);
  }

  const catalog = readJson(catalogPath);
  const recipePath = path.join(workDir, ARTIFACTS.recipeDraft);
  const hasRecipe = fs.existsSync(recipePath);
  const perClipAnalysis = loadPerClipAudioAnalysisForCatalog(workDir, catalog);
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  let existingIndex = resolveEnhancementIndex(workDir, catalog);
  if (!fs.existsSync(indexPath) && existingIndex) {
    writeJson(indexPath, existingIndex);
  }

  if (!force && shouldUseCachedArtifact(workDir, ARTIFACTS.audioEnhancementIndex, force)) {
    maybeReconcileRecipe(workDir, recipePath, existingIndex, perClipAnalysis);
    return existingIndex;
  }

  const alreadyEnhanced = catalogClipsAlreadyEnhanced(catalog, existingIndex, workDir);
  if (!force && alreadyEnhanced.complete) {
    const index = writeEnhancementIndex(
      workDir,
      catalog,
      alreadyEnhanced.manifests,
      hasRecipe ? EditRecipeV2Schema.parse(readJson(recipePath)) : null,
      { perClipAnalysis },
    );
    return index;
  }

  const recipe = hasRecipe ? EditRecipeV2Schema.parse(readJson(recipePath)) : null;
  const acceptByClip = new Map(
    (recipe ? collectAcceptedDecisions(recipe) : []).map((decision) => [decision.clipId, decision]),
  );

  // Always denoise every catalog clip for Whisper. Prefer recipe accept metadata (polish/LUFS)
  // when present; reject does not skip materialization (render still honors reject).
  const decisions = (catalog.clips ?? []).map(
    (clip) => acceptByClip.get(clip.clipId) ?? buildEnhanceAllDecision(clip.clipId),
  );

  if (!decisions.length) {
    return writeEnhancementIndex(workDir, catalog, [], recipe, { perClipAnalysis });
  }

  return enhanceDecisions({
    workDir,
    catalog,
    decisions,
    config,
    perClipAnalysis,
    force,
    recipe,
  });
}

export function loadAudioEnhancementIndex(workDir, catalog = null) {
  const indexPath = path.join(workDir, ARTIFACTS.audioEnhancementIndex);
  if (fs.existsSync(indexPath)) {
    return readJson(indexPath);
  }
  if (!catalog) {
    const catalogPath = path.join(workDir, ARTIFACTS.sceneCatalog);
    if (!fs.existsSync(catalogPath)) {
      return null;
    }
    catalog = readJson(catalogPath);
  }
  return rebuildEnhancementIndexFromDisk(workDir, catalog);
}
