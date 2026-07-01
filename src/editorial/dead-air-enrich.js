import { buildDeadAirMontageHints } from "./editorial-context.js";
import { mapSourceTimeToOutputSec } from "./shorts-retention.js";

const DEFAULT_TOLERANCE_SEC = 0.8;
const DEFAULT_MIN_GAP_SEC = 45;
const DEFAULT_DURATION_SEC = 0.8;

function roundSec(value) {
  return Math.round(value * 10) / 10;
}

export function hasSilenceBeatNearSec(moments, outputSec, toleranceSec = DEFAULT_TOLERANCE_SEC) {
  return (moments ?? []).some((moment) => {
    if (moment.techniqueId !== "silence_beat") {
      return false;
    }
    const anchor = moment.outputStartSec ?? moment.anchorSec ?? 0;
    return Math.abs(anchor - outputSec) <= toleranceSec;
  });
}

function hasSilenceBeatGapViolation(moments, outputSec, minGapSec) {
  return (moments ?? []).some((moment) => {
    if (moment.techniqueId !== "silence_beat") {
      return false;
    }
    const anchor = moment.outputStartSec ?? 0;
    return Math.abs(anchor - outputSec) < minGapSec;
  });
}

/**
 * Adds silence_beat creativeMoments for high-confidence dead air (source: both).
 */
export function enrichRecipeSilenceBeatFromDeadAir(recipe, {
  audioIndex,
  timelineIndex: _timelineIndex,
  hints = null,
  maxMoments = 3,
  minGapFromSameTechniqueSec = DEFAULT_MIN_GAP_SEC,
  anchorToleranceSec = DEFAULT_TOLERANCE_SEC,
  durationSec = DEFAULT_DURATION_SEC,
} = {}) {
  const mainOutput = recipe.outputs?.find((output) => output.outputKind === "main");
  if (!mainOutput?.timeline?.length) {
    return recipe.creativeMoments ?? [];
  }

  const resolvedHints = hints ?? buildDeadAirMontageHints(audioIndex);
  const existing = [...(recipe.creativeMoments ?? [])];
  const newMoments = [];

  for (const hint of [...resolvedHints].sort((a, b) => b.durationSec - a.durationSec)) {
    if (newMoments.length >= maxMoments) {
      break;
    }

    const outputStartSec = mapSourceTimeToOutputSec(recipe, hint.clipId, hint.endSec, {
      outputKind: "main",
    });
    if (outputStartSec == null) {
      continue;
    }

    if (hasSilenceBeatNearSec([...existing, ...newMoments], outputStartSec, anchorToleranceSec)) {
      continue;
    }
    if (hasSilenceBeatGapViolation([...existing, ...newMoments], outputStartSec, minGapFromSameTechniqueSec)) {
      continue;
    }

    newMoments.push({
      momentId: `enrich_silence_${String(newMoments.length + 1).padStart(3, "0")}`,
      techniqueId: "silence_beat",
      outputId: mainOutput.outputId,
      outputStartSec,
      outputEndSec: roundSec(outputStartSec + durationSec),
      params: { durationSec },
      reason: `Enriched silence_beat at dead air ${hint.startSec}–${hint.endSec}s (source: both)`,
      confidence: 0.7,
    });
  }

  return [...existing, ...newMoments];
}
