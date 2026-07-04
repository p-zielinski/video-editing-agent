import { buildOutputTimeline } from "../lib/build-output-timeline.js";
import { buildAudioIndexSummary, lookupWordIndex } from "../editorial/audio-index-summary.js";
import { buildDeadAirMontageHints } from "../editorial/editorial-context.js";
import { hasSilenceBeatNearSec } from "../editorial/dead-air-enrich.js";
import { mapSourceTimeToOutputSec, resolveMainOutputDurationSec } from "../editorial/shorts-retention.js";
import {
  findL2SegmentIdForSourceTime,
  resolveRecipeNarrativeProfile,
  resolveSilencePolicyForHint,
} from "../lib/narrative-profile.js";

export const DEAD_AIR_COVERAGE_VALIDATOR_CODE = "V26-DEADAIR-01";
export const DEAD_AIR_COVERAGE_TOLERANCE_SEC = 0.8;
const BOUNDARY_TOLERANCE_SEC = 0.15;

function findMainOutput(outputs = []) {
  return outputs.find(
    (output) => output.outputKind === "main" || output.format === "16:9",
  );
}

function resolveSegmentClipId(segment) {
  return segment.audioRef?.clipId ?? segment.videoRef?.clipId ?? null;
}

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function shouldPreserveSilence(recipe, hint, abstraction, timelineIndex) {
  const narrativeProfile = resolveRecipeNarrativeProfile(recipe);
  if (!narrativeProfile || !hint) {
    return false;
  }

  const midSec = (hint.startSec + hint.endSec) / 2;
  const l2SegmentId = findL2SegmentIdForSourceTime(
    abstraction,
    timelineIndex,
    hint.clipId,
    midSec,
  );
  return resolveSilencePolicyForHint(narrativeProfile, l2SegmentId) === "preserve";
}

function hintCoveredByCut(recipe, hint, wordIndexes, timelineIndex) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return false;
  }

  for (const segment of mainOutput.timeline ?? []) {
    if (resolveSegmentClipId(segment) !== hint.clipId) {
      continue;
    }

    const { audioIn, audioOut } = resolveSegmentRange(segment);
    if (hint.startSec >= audioOut || hint.endSec <= audioIn) {
      continue;
    }

    if (
      hint.startSec <= audioIn + BOUNDARY_TOLERANCE_SEC
      && (segment.videoInSec ?? audioIn) > audioIn + BOUNDARY_TOLERANCE_SEC
      && (segment.videoInSec ?? audioIn) >= hint.endSec - BOUNDARY_TOLERANCE_SEC
    ) {
      return true;
    }

    if (
      hint.endSec >= audioOut - BOUNDARY_TOLERANCE_SEC
      && (segment.videoOutSec ?? audioOut) < audioOut - BOUNDARY_TOLERANCE_SEC
      && (segment.videoOutSec ?? audioOut) <= hint.startSec + BOUNDARY_TOLERANCE_SEC
    ) {
      return true;
    }

    const wordIndex = lookupWordIndex(hint.clipId, wordIndexes, timelineIndex);
    for (const cut of segment.cuts ?? []) {
      if (cut.reason !== "dead_air" || !wordIndex?.words?.length) {
        continue;
      }

      const wordBefore = wordIndex.words.find((word) => word.wordId === cut.startWordId);
      const wordAfter = wordIndex.words.find((word) => word.wordId === cut.endWordId);
      if (!wordBefore || !wordAfter) {
        continue;
      }

      if (
        wordBefore.end <= hint.startSec + BOUNDARY_TOLERANCE_SEC
        && wordAfter.start >= hint.endSec - BOUNDARY_TOLERANCE_SEC
      ) {
        return true;
      }
    }
  }

  return false;
}

function hintCoveredBySilenceBeat(recipe, hint, wordIndexes, toleranceSec) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput) {
    return false;
  }

  const outputSec = mapSourceTimeToOutputSec(recipe, hint.clipId, hint.endSec, {
    outputKind: "main",
    wordIndexes,
  });
  if (outputSec == null) {
    return false;
  }

  const moments = (recipe.creativeMoments ?? []).filter(
    (moment) => moment.outputId === mainOutput.outputId,
  );
  return hasSilenceBeatNearSec(moments, outputSec, toleranceSec);
}

function resolveDeadAirHints(recipe, audioIndex, { wordIndexes, timelineIndex, perClipAnalysis } = {}) {
  if (!audioIndex?.clips?.length) {
    return [];
  }

  const summary = buildAudioIndexSummary(audioIndex, {
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
    narrativeProfile: resolveRecipeNarrativeProfile(recipe),
  });
  return buildDeadAirMontageHints(summary);
}

/**
 * Warn when fused deadAirHints (source: both) are not addressed by cut or silence_beat.
 *
 * @param {object} recipe
 * @param {{
 *   audioIndex?: object,
 *   abstraction?: object,
 *   timelineIndex?: object,
 *   wordIndexes?: object[],
 *   perClipAnalysis?: object[],
 * }} [options]
 */
export function validateDeadAirCoverage(recipe, {
  audioIndex,
  abstraction,
  timelineIndex,
  wordIndexes,
  perClipAnalysis,
} = {}) {
  const mainOutput = findMainOutput(recipe.outputs ?? []);
  if (!mainOutput?.timeline?.length) {
    return [];
  }

  const durationSec = resolveMainOutputDurationSec({
    outputs: recipe.outputs ?? [],
    batchContext: recipe.batchContext ?? {},
  });
  if (durationSec <= 0) {
    return [];
  }

  buildOutputTimeline(mainOutput, { wordIndexes });

  const hints = resolveDeadAirHints(recipe, audioIndex, {
    wordIndexes,
    timelineIndex,
    perClipAnalysis,
  });
  if (!hints.length) {
    return [];
  }

  const issues = [];
  for (const hint of hints) {
    if (hint.source !== "both") {
      continue;
    }
    if (shouldPreserveSilence(recipe, hint, abstraction, timelineIndex)) {
      continue;
    }

    const coveredByCut = hintCoveredByCut(recipe, hint, wordIndexes, timelineIndex);
    const coveredByBeat = hintCoveredBySilenceBeat(
      recipe,
      hint,
      wordIndexes,
      DEAD_AIR_COVERAGE_TOLERANCE_SEC,
    );
    if (coveredByCut || coveredByBeat) {
      continue;
    }

    issues.push({
      severity: "warning",
      code: DEAD_AIR_COVERAGE_VALIDATOR_CODE,
      message: `Dead air ${hint.startSec.toFixed(1)}–${hint.endSec.toFixed(1)}s (${hint.clipId}, source: both) `
        + "bez cut dead_air ani silence_beat w tolerancji",
      outputId: mainOutput.outputId,
      sceneId: hint.sceneId,
    });
  }

  return issues;
}
