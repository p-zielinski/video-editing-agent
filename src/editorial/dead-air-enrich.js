import { buildDeadAirMontageHints, buildSilenceBeatDipHints } from "./editorial-context.js";
import { buildAudioIndexSummary, lookupWordIndex } from "./audio-index-summary.js";
import { mapSourceTimeToOutputSec } from "./shorts-retention.js";
import {
  findL2SegmentIdForSourceTime,
  resolveRecipeNarrativeProfile,
  resolveSilencePolicyForHint,
} from "../lib/narrative-profile.js";

const DEFAULT_TOLERANCE_SEC = 0.8;
const DEFAULT_MIN_GAP_SEC = 45;
const DEFAULT_DURATION_SEC = 0.8;
const MIN_DEAD_AIR_GAP_SEC = 0.5;
const BOUNDARY_TOLERANCE_SEC = 0.15;

function roundSec(value) {
  return Math.round(value * 10) / 10;
}

function resolveTaggedAudioSummary(recipe, {
  audioIndex,
  perClipAnalysis = null,
  wordIndexes = null,
  timelineIndex = null,
} = {}) {
  if (!audioIndex?.clips?.length) {
    return null;
  }
  return buildAudioIndexSummary(audioIndex, {
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
    narrativeProfile: resolveRecipeNarrativeProfile(recipe),
  });
}

function resolveTaggedDeadAirMontageHints(recipe, options = {}) {
  if (options.hints) {
    return options.hints;
  }
  const audioSummary = resolveTaggedAudioSummary(recipe, options);
  return audioSummary ? buildDeadAirMontageHints(audioSummary) : [];
}

function resolveTaggedDeadAirSilenceHints(recipe, options = {}) {
  if (options.hints) {
    return options.hints;
  }
  const audioSummary = resolveTaggedAudioSummary(recipe, options);
  if (!audioSummary) {
    return [];
  }
  return [
    ...buildDeadAirMontageHints(audioSummary),
    ...buildSilenceBeatDipHints(audioSummary),
  ];
}

function deadAirHintKey(hint) {
  return `${hint.clipId}:${hint.startSec}:${hint.endSec}`;
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

function resolveSegmentClipId(segment) {
  return segment.audioRef?.clipId ?? segment.videoRef?.clipId ?? null;
}

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function clipHintToSegment(hint, segment) {
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const startSec = Math.max(hint.startSec, audioIn);
  const endSec = Math.min(hint.endSec, audioOut);
  return {
    ...hint,
    startSec,
    endSec,
    durationSec: roundSec(endSec - startSec),
  };
}

function findSegmentForHint(timeline, clipId, hint) {
  for (const segment of timeline) {
    if (resolveSegmentClipId(segment) !== clipId) {
      continue;
    }
    const { audioIn, audioOut } = resolveSegmentRange(segment);
    if (hint.startSec < audioOut && hint.endSec > audioIn) {
      return segment;
    }
  }
  return null;
}

function deadAirOverlapsSpokenWord(hint, wordIndex, tolerance = BOUNDARY_TOLERANCE_SEC) {
  if (!wordIndex?.words?.length) {
    return false;
  }

  for (const word of wordIndex.words) {
    const interiorStart = word.start + tolerance;
    const interiorEnd = word.end - tolerance;
    if (interiorEnd <= interiorStart) {
      continue;
    }
    if (hint.startSec < interiorEnd && hint.endSec > interiorStart) {
      return true;
    }
  }
  return false;
}

function findBracketingWords(hint, wordIndex) {
  if (!wordIndex?.words?.length) {
    return { wordBefore: null, wordAfter: null };
  }

  const words = [...wordIndex.words].sort((a, b) => a.start - b.start);
  let wordBefore = null;
  let wordAfter = null;

  for (const word of words) {
    if (word.end <= hint.startSec + BOUNDARY_TOLERANCE_SEC) {
      wordBefore = word;
    }
    if (!wordAfter && word.start >= hint.endSec - BOUNDARY_TOLERANCE_SEC) {
      wordAfter = word;
    }
  }

  return { wordBefore, wordAfter };
}

function hasDeadAirCut(segment, startWordId, endWordId) {
  return (segment.cuts ?? []).some(
    (cut) => cut.reason === "dead_air"
      && cut.startWordId === startWordId
      && cut.endWordId === endWordId,
  );
}

function tryEdgeTrim(segment, hint) {
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const gapDuration = hint.endSec - hint.startSec;
  if (gapDuration < MIN_DEAD_AIR_GAP_SEC) {
    return false;
  }

  if (
    hint.startSec <= audioIn + BOUNDARY_TOLERANCE_SEC
    && hint.endSec > audioIn + BOUNDARY_TOLERANCE_SEC
    && hint.endSec < audioOut - BOUNDARY_TOLERANCE_SEC
  ) {
    const newIn = roundSec(Math.max(audioIn, hint.endSec));
    if (newIn >= audioOut) {
      return false;
    }
    segment.videoInSec = newIn;
    segment.audioInSec = newIn;
    return true;
  }

  if (
    hint.endSec >= audioOut - BOUNDARY_TOLERANCE_SEC
    && hint.startSec > audioIn + BOUNDARY_TOLERANCE_SEC
    && hint.startSec < audioOut - BOUNDARY_TOLERANCE_SEC
  ) {
    const newOut = roundSec(Math.min(audioOut, hint.startSec));
    if (audioIn >= newOut) {
      return false;
    }
    segment.videoOutSec = newOut;
    segment.audioOutSec = newOut;
    return true;
  }

  return false;
}

function tryInterWordCut(segment, hint, wordIndex) {
  const { wordBefore, wordAfter } = findBracketingWords(hint, wordIndex);
  if (!wordBefore || !wordAfter || wordBefore.wordId === wordAfter.wordId) {
    return false;
  }

  if (
    hint.startSec < wordBefore.end - BOUNDARY_TOLERANCE_SEC
    || hint.endSec > wordAfter.start + BOUNDARY_TOLERANCE_SEC
  ) {
    return false;
  }

  if (hasDeadAirCut(segment, wordBefore.wordId, wordAfter.wordId)) {
    return true;
  }

  segment.cuts = [...(segment.cuts ?? []), {
    startWordId: wordBefore.wordId,
    endWordId: wordAfter.wordId,
    reason: "dead_air",
  }];
  return true;
}

function isDeadAirCutSafe(hint, wordIndex, segment) {
  if ((hint.endSec - hint.startSec) < MIN_DEAD_AIR_GAP_SEC) {
    return false;
  }

  if (deadAirOverlapsSpokenWord(hint, wordIndex)) {
    return false;
  }

  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const atStart = hint.startSec <= audioIn + BOUNDARY_TOLERANCE_SEC
    && hint.endSec > audioIn + BOUNDARY_TOLERANCE_SEC;
  const atEnd = hint.endSec >= audioOut - BOUNDARY_TOLERANCE_SEC
    && hint.startSec < audioOut - BOUNDARY_TOLERANCE_SEC;

  if (atStart || atEnd) {
    return true;
  }

  const { wordBefore, wordAfter } = findBracketingWords(hint, wordIndex);
  return Boolean(wordBefore && wordAfter && wordBefore.wordId !== wordAfter.wordId);
}

function applyDeadAirCutToSegment(segment, hint, wordIndex) {
  if (tryEdgeTrim(segment, hint)) {
    return true;
  }
  return tryInterWordCut(segment, hint, wordIndex);
}

/**
 * Mutates recipe timeline: trims dead air from segments for high-confidence hints.
 * Returns metadata about applied cuts for silence_beat fallback gating.
 */
export function enrichRecipeDeadAirCuts(recipe, {
  audioIndex,
  timelineIndex = null,
  wordIndexes = null,
  perClipAnalysis = null,
  hints = null,
  maxCuts = 6,
  abstraction = null,
} = {}) {
  const mainOutput = recipe.outputs?.find((output) => output.outputKind === "main");
  const emptyResult = { appliedCuts: 0, cutHintKeys: new Set() };

  if (!mainOutput?.timeline?.length) {
    return emptyResult;
  }

  const resolvedHints = resolveTaggedDeadAirMontageHints(recipe, {
    audioIndex,
    perClipAnalysis,
    wordIndexes,
    timelineIndex,
    hints,
  });
  const cutHintKeys = new Set();
  let appliedCuts = 0;

  for (const hint of [...resolvedHints].sort((a, b) => b.durationSec - a.durationSec)) {
    if (appliedCuts >= maxCuts) {
      break;
    }
    if (hint.source !== "both") {
      continue;
    }
    if (hint.silenceKind && hint.silenceKind !== "dead_air") {
      continue;
    }
    if (shouldPreserveSilence(recipe, hint, abstraction, timelineIndex)) {
      continue;
    }

    const segment = findSegmentForHint(mainOutput.timeline, hint.clipId, hint);
    if (!segment) {
      continue;
    }

    const segmentHint = clipHintToSegment(hint, segment);
    if (segmentHint.durationSec < MIN_DEAD_AIR_GAP_SEC) {
      continue;
    }

    const wordIndex = lookupWordIndex(hint.clipId, wordIndexes, timelineIndex);
    if (!isDeadAirCutSafe(segmentHint, wordIndex, segment)) {
      continue;
    }

    if (applyDeadAirCutToSegment(segment, segmentHint, wordIndex)) {
      appliedCuts += 1;
      cutHintKeys.add(deadAirHintKey(hint));
    }
  }

  return { appliedCuts, cutHintKeys };
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
 * Adds silence_beat creativeMoments for high-confidence dead air (source: both)
 * when timeline cuts were not applied (unsafe overlap or silencePolicy).
 */
export function enrichRecipeSilenceBeatFromDeadAir(recipe, {
  audioIndex,
  timelineIndex: _timelineIndex,
  perClipAnalysis = null,
  wordIndexes = null,
  hints = null,
  cutHintKeys = null,
  maxMoments = 3,
  minGapFromSameTechniqueSec = DEFAULT_MIN_GAP_SEC,
  anchorToleranceSec = DEFAULT_TOLERANCE_SEC,
  durationSec = DEFAULT_DURATION_SEC,
  abstraction = null,
} = {}) {
  const mainOutput = recipe.outputs?.find((output) => output.outputKind === "main");
  if (!mainOutput?.timeline?.length) {
    return recipe.creativeMoments ?? [];
  }

  const resolvedHints = resolveTaggedDeadAirSilenceHints(recipe, {
    audioIndex,
    perClipAnalysis,
    wordIndexes,
    timelineIndex: _timelineIndex,
    hints,
  });
  const existing = [...(recipe.creativeMoments ?? [])];
  const newMoments = [];
  const skippedKeys = cutHintKeys ?? new Set();

  for (const hint of [...resolvedHints].sort((a, b) => b.durationSec - a.durationSec)) {
    if (newMoments.length >= maxMoments) {
      break;
    }
    if (skippedKeys.has(deadAirHintKey(hint))) {
      continue;
    }
    if (hint.source !== "both") {
      continue;
    }
    if (hint.silenceKind === "dramatic_pause") {
      continue;
    }
    if (shouldPreserveSilence(recipe, hint, abstraction, _timelineIndex)) {
      continue;
    }

    const outputStartSec = mapSourceTimeToOutputSec(recipe, hint.clipId, hint.endSec, {
      outputKind: "main",
      wordIndexes,
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
      reason: hint.silenceKind === "breath_before_punchline"
        ? `Enriched silence_beat at breath_before_punchline ${hint.startSec}–${hint.endSec}s`
        : `Enriched silence_beat at dead air ${hint.startSec}–${hint.endSec}s (source: both)`,
      confidence: hint.silenceKind === "breath_before_punchline" ? 0.55 : 0.7,
    });
  }

  return [...existing, ...newMoments];
}

/**
 * Applies timeline dead-air cuts first, then silence_beat fallback for unsafe hints.
 */
export function enrichRecipeDeadAirHandling(recipe, options = {}) {
  const { appliedCuts: _appliedCuts, cutHintKeys } = enrichRecipeDeadAirCuts(recipe, options);
  return enrichRecipeSilenceBeatFromDeadAir(recipe, {
    ...options,
    cutHintKeys,
  });
}
