import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS, readJson, writeJson } from "../pipeline/work-paths.js";

export const MONTAGE_FIDELITY_VERSION = "1.0";
export const DURATION_DRIFT_WARN_SEC = 1.0;

/**
 * @param {object} segment
 * @param {object} context
 * @returns {"original"|"enhanced"|"speech_ambient_duck"|null}
 */
export function classifySegmentAudioSource(segment, context) {
  if (segment?.audioSourceDuck?.mode === "speech_ambient_duck"
    || segment?.audioSource === "speech_ambient_duck") {
    return "speech_ambient_duck";
  }
  const audioPath = segment?.audioSourcePath ?? null;
  if (!audioPath) {
    return null;
  }
  const clipIds = [
    segment.audioRef?.clipId,
    segment.videoRef?.clipId,
  ].filter(Boolean);
  for (const clipId of clipIds) {
    const enhanced = context?.enhancedAudioPaths?.[clipId];
    if (enhanced && path.resolve(enhanced) === path.resolve(audioPath)) {
      return "enhanced";
    }
  }
  return "original";
}

/**
 * @param {string} clipId
 * @param {object|null} recipe
 * @param {object|null} enhancementIndex
 */
export function resolveEnhancementMeta(clipId, recipe, enhancementIndex) {
  if (!clipId) {
    return {
      enhancementDecision: "none",
      enhancementIndexStatus: "missing",
    };
  }
  const decision = (recipe?.audioEnhancementDecisions ?? []).find((d) => d.clipId === clipId);
  const indexEntry = (enhancementIndex?.clips ?? []).find((c) => c.clipId === clipId);
  return {
    enhancementDecision: decision?.action ?? "none",
    enhancementIndexStatus: indexEntry?.status ?? "missing",
  };
}

/**
 * @param {object} segment
 * @param {object} context
 * @param {object|null} recipe
 * @param {object|null} enhancementIndex
 */
export function buildSegmentFidelity(segment, context, recipe, enhancementIndex) {
  const clipIds = [...new Set([
    segment.videoRef?.clipId,
    segment.audioRef?.clipId,
  ].filter(Boolean))];
  const primaryClipId = segment.audioRef?.clipId
    ?? segment.videoRef?.clipId
    ?? clipIds[0]
    ?? null;
  const enhancement = resolveEnhancementMeta(primaryClipId, recipe, enhancementIndex);
  return {
    segmentId: segment.segmentId,
    clipIds,
    audioSource: segment.audioSource
      ?? classifySegmentAudioSource(segment, context),
    preserveAmbientAudio: segment.preserveAmbientAudio === true,
    enhancementDecision: enhancement.enhancementDecision,
    enhancementIndexStatus: enhancement.enhancementIndexStatus,
  };
}

/**
 * @param {object[]} moments
 * @param {object[]} warnings
 * @param {{ appliedMomentIds?: string[], appliedTechniqueIds?: string[] }} [creativeResult]
 */
export function buildCreativeFidelity(moments, warnings = [], creativeResult = {}) {
  const planned = (moments ?? []).map((m) => ({
    momentId: m.momentId ?? null,
    techniqueId: m.techniqueId,
  }));
  const plannedTechniqueIds = [...new Set(planned.map((p) => p.techniqueId).filter(Boolean))];

  const disabled = (moments ?? [])
    .filter((m) => m.disabled === true)
    .map((m) => ({
      momentId: m.momentId ?? null,
      techniqueId: m.techniqueId,
      reason: m.reason ?? "disabled",
    }));

  const fallbacks = (warnings ?? [])
    .filter((w) => w.code === "CREATIVE_FALLBACK")
    .map((w) => ({
      code: "CREATIVE_FALLBACK",
      momentId: w.momentId ?? w.momentIds?.[0] ?? null,
      momentIds: w.momentIds ?? (w.momentId ? [w.momentId] : []),
      techniqueId: w.techniqueId ?? w.techniqueIds?.[0] ?? null,
      techniqueIds: w.techniqueIds ?? (w.techniqueId ? [w.techniqueId] : []),
      message: w.message ?? "",
    }));

  let applied = [];
  if (Array.isArray(creativeResult.appliedTechniqueIds)) {
    applied = [...creativeResult.appliedTechniqueIds];
  } else if (Array.isArray(creativeResult.appliedMomentIds) && creativeResult.appliedMomentIds.length) {
    const appliedMomentIds = new Set(creativeResult.appliedMomentIds);
    applied = planned
      .filter((p) => appliedMomentIds.has(p.momentId))
      .map((p) => p.techniqueId)
      .filter(Boolean);
  }
  // Whole creative ffmpeg pass failed → no applied video techniques.
  if (fallbacks.length > 0) {
    applied = [];
  }

  return {
    planned: plannedTechniqueIds,
    plannedMoments: planned,
    applied: [...new Set(applied)],
    fallbacks,
    disabled,
  };
}

/**
 * @param {object|null} mixResult
 */
export function buildAudioMixFidelity(mixResult) {
  if (!mixResult) {
    return {
      applied: false,
      duckingWindowCount: 0,
      duckingSource: null,
      appliedAudioTechniques: [],
      warnings: [],
    };
  }
  return {
    applied: mixResult.applied === true,
    duckingWindowCount: mixResult.duckingWindowCount ?? 0,
    duckingSource: mixResult.duckingSource ?? null,
    appliedAudioTechniques: mixResult.appliedAudioTechniques ?? [],
    warnings: (mixResult.warnings ?? []).map((w) => ({
      code: w.code ?? "warn",
      message: w.message ?? String(w),
      sfxId: w.sfxId ?? null,
    })),
  };
}

export function recipeOutputDurationSec(output) {
  const ends = (output?.timeline ?? []).map((seg) => seg.outputEndSec ?? 0);
  return ends.length > 0 ? Math.max(...ends) : 0;
}

/**
 * Build one output fidelity entry (pure; no I/O).
 */
export function buildOutputFidelityEntry({
  output,
  recipe,
  edl,
  context,
  probedDurationSec = null,
  warnings = [],
  creativeResult = {},
  mixResult = null,
  enhancementIndex = null,
}) {
  const edlDurationSec = edl?.durationSec ?? 0;
  const recipeDurationSec = recipeOutputDurationSec(output);
  const probed = probedDurationSec == null ? null : Number(probedDurationSec);
  const durationDriftSec = probed == null ? null : probed - edlDurationSec;

  const segments = (edl?.segments ?? []).map((segment) => (
    buildSegmentFidelity(segment, context, recipe, enhancementIndex)
  ));

  const moments = edl?.creativeMoments
    ?? (recipe?.creativeMoments ?? []).filter((m) => m.outputId === output.outputId);

  return {
    outputId: output.outputId,
    format: output.format ?? null,
    outputPath: null,
    recipeDurationSec,
    edlDurationSec,
    probedDurationSec: probed,
    durationDriftSec,
    segments,
    creative: buildCreativeFidelity(moments, warnings, creativeResult),
    audioMix: buildAudioMixFidelity(mixResult),
  };
}

export function createEmptyFidelityArtifact({ batchId, recipePath = ARTIFACTS.recipeFinal } = {}) {
  return {
    version: MONTAGE_FIDELITY_VERSION,
    batchId: batchId ?? null,
    recipePath,
    updatedAt: new Date().toISOString(),
    outputs: [],
  };
}

/**
 * Merge / upsert one output entry into the fidelity artifact.
 */
export function mergeFidelityOutput(artifact, entry) {
  const base = artifact?.version
    ? { ...artifact, outputs: [...(artifact.outputs ?? [])] }
    : createEmptyFidelityArtifact({ batchId: entry?.batchId });
  const outputs = base.outputs.filter((o) => o.outputId !== entry.outputId);
  outputs.push(entry);
  return {
    ...base,
    updatedAt: new Date().toISOString(),
    outputs,
  };
}

export function loadMontageFidelity(workDir) {
  const filePath = path.join(workDir, ARTIFACTS.montageFidelity);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

export function writeMontageFidelity(workDir, artifact) {
  const filePath = path.join(workDir, ARTIFACTS.montageFidelity);
  writeJson(filePath, artifact);
  return filePath;
}

/**
 * CLI / summary warnings — soft only (never hard-fail).
 */
export function collectFidelityCliWarnings(fidelity) {
  const warnings = [];
  for (const output of fidelity?.outputs ?? []) {
    const drift = output.durationDriftSec;
    if (drift != null && Math.abs(drift) > DURATION_DRIFT_WARN_SEC) {
      warnings.push({
        code: "DURATION_DRIFT",
        outputId: output.outputId,
        durationDriftSec: drift,
        message: `${output.outputId}: |durationDriftSec|=${Math.abs(drift).toFixed(2)}s > ${DURATION_DRIFT_WARN_SEC}`,
      });
    }
    for (const fallback of output.creative?.fallbacks ?? []) {
      warnings.push({
        code: "CREATIVE_FALLBACK",
        outputId: output.outputId,
        momentId: fallback.momentId,
        techniqueId: fallback.techniqueId,
        message: `${output.outputId}: CREATIVE_FALLBACK`
          + (fallback.momentId ? ` moment=${fallback.momentId}` : "")
          + (fallback.techniqueId ? ` technique=${fallback.techniqueId}` : "")
          + (fallback.message ? ` — ${fallback.message}` : ""),
      });
    }
  }
  return warnings;
}

/**
 * Assemble + persist fidelity for one rendered output (merge across outputs).
 */
export function recordOutputFidelity(workDir, {
  batchId,
  output,
  recipe,
  edl,
  context,
  result,
  enhancementIndex = null,
}) {
  const entry = buildOutputFidelityEntry({
    output,
    recipe,
    edl,
    context,
    probedDurationSec: result?.durationSec ?? null,
    warnings: result?.warnings ?? [],
    creativeResult: {
      appliedMomentIds: result?.appliedCreativeMomentIds,
      appliedTechniqueIds: result?.appliedCreativeTechniqueIds,
    },
    mixResult: result?.mixResult ?? null,
    enhancementIndex: enhancementIndex
      ?? context?.audioEnhancementIndex
      ?? null,
  });
  entry.outputPath = result?.outputPath ?? null;

  const existing = loadMontageFidelity(workDir);
  const artifact = mergeFidelityOutput(
    existing ?? createEmptyFidelityArtifact({ batchId: batchId ?? recipe?.batchId }),
    entry,
  );
  if (!artifact.batchId) {
    artifact.batchId = batchId ?? recipe?.batchId ?? null;
  }
  writeMontageFidelity(workDir, artifact);
  return { artifact, entry };
}
