import { lookupWordIndex } from "./audio-index-summary.js";

/** Reason written on audioEnhancementDecisions when preserving in-clip ambient. */
export const INTENTIONAL_AMBIENT_REJECT_REASON = "intentional_ambient_preserve";

/** Music bed level under intentional ambient showcase (full unduck). */
export const AMBIENT_SHOWCASE_DUCK_DB = 0;

/**
 * Focused PL/EN listen / nature cues. Keep list small to avoid false positives.
 */
export const AMBIENT_LISTEN_CUE_PATTERNS = [
  /\bposłuchaj(?:cie|my)?\b/i,
  /\bsłychać\b/i,
  /\bptak(?:i|ów|ami)?\b/i,
  /\bśpiew\b/i,
  /\bbirds?\b/i,
  /\blisten\b/i,
  /\bhear the\b/i,
  /\bnature sounds?\b/i,
  /\bambient\b/i,
];

/** Auto / enrich speech-accept reasons we may overwrite with ambient reject. */
const AUTO_SPEECH_ACCEPT_REASON_RE = /auto-accept|speech a-roll|enrich/i;

const EXTERNAL_OR_MUTE = new Set(["external", "mute", "from_prev", "from_next"]);

/** Max length of a following silence-heavy segment to also mark preserve. */
const FOLLOW_SILENCE_MAX_SEC = 12;
/** Max speech coverage ratio on a follow segment to treat as silence-heavy. */
const FOLLOW_SILENCE_MAX_SPEECH_RATIO = 0.15;

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function resolveSegmentClipId(segment) {
  return segment.audioRef?.clipId ?? segment.videoRef?.clipId ?? null;
}

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function resolveSegmentOutputRange(segment) {
  const start = segment.outputStartSec;
  const end = segment.outputEndSec;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const { audioIn, audioOut } = resolveSegmentRange(segment);
    return { start: 0, end: Math.max(0, audioOut - audioIn) };
  }
  return { start, end };
}

/**
 * Join overlapping word texts in [audioIn, audioOut] (with small pad).
 */
export function collectSegmentTranscript(segment, wordIndexes, { padSec = 0.5 } = {}) {
  const clipId = resolveSegmentClipId(segment);
  if (!clipId) {
    return "";
  }
  const wordIndex = lookupWordIndex(clipId, wordIndexes, null);
  if (!wordIndex?.words?.length) {
    return "";
  }
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const start = Math.max(0, audioIn - padSec);
  const end = audioOut + padSec;
  return wordIndex.words
    .filter((word) => word.end > start && word.start < end)
    .map((word) => String(word.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * @param {string} transcript
 * @returns {boolean}
 */
export function detectsIntentionalAmbientCue(transcript) {
  if (!transcript || typeof transcript !== "string") {
    return false;
  }
  return AMBIENT_LISTEN_CUE_PATTERNS.some((pattern) => pattern.test(transcript));
}

function segmentSpeechRatio(segment, wordIndexes) {
  const clipId = resolveSegmentClipId(segment);
  if (!clipId) {
    return 0;
  }
  const wordIndex = lookupWordIndex(clipId, wordIndexes, null);
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const duration = Math.max(0.001, audioOut - audioIn);
  if (!wordIndex?.words?.length) {
    return 0;
  }
  let speechSec = 0;
  for (const word of wordIndex.words) {
    const start = Math.max(word.start, audioIn);
    const end = Math.min(word.end, audioOut);
    if (end > start) {
      speechSec += end - start;
    }
  }
  return speechSec / duration;
}

function isSilenceHeavyFollowSegment(segment, wordIndexes) {
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const duration = audioOut - audioIn;
  if (duration <= 0 || duration > FOLLOW_SILENCE_MAX_SEC) {
    return false;
  }
  return segmentSpeechRatio(segment, wordIndexes) <= FOLLOW_SILENCE_MAX_SPEECH_RATIO;
}

function segmentCarriesClipAudio(segment) {
  if (EXTERNAL_OR_MUTE.has(segment.audioPolicy)) {
    return false;
  }
  return Boolean(resolveSegmentClipId(segment));
}

/**
 * Mark cue segments (+ optional following silence-heavy same-clip segment).
 * @returns {string[]} segmentIds marked
 */
export function markPreserveAmbientSegments(recipe, { wordIndexes = null } = {}) {
  const marked = [];

  for (const output of recipe?.outputs ?? []) {
    const timeline = output.timeline ?? [];
    for (let i = 0; i < timeline.length; i += 1) {
      const segment = timeline[i];
      if (!segmentCarriesClipAudio(segment)) {
        continue;
      }
      if (segment.preserveAmbientAudio === true) {
        continue;
      }

      const transcript = collectSegmentTranscript(segment, wordIndexes);
      if (!detectsIntentionalAmbientCue(transcript)) {
        continue;
      }

      segment.preserveAmbientAudio = true;
      marked.push(segment.segmentId);

      const clipId = resolveSegmentClipId(segment);
      const next = timeline[i + 1];
      if (
        next
        && segmentCarriesClipAudio(next)
        && resolveSegmentClipId(next) === clipId
        && next.preserveAmbientAudio !== true
        && isSilenceHeavyFollowSegment(next, wordIndexes)
      ) {
        next.preserveAmbientAudio = true;
        marked.push(next.segmentId);
      }
    }
  }

  return marked;
}

/**
 * Remove director false-positive preserveAmbientAudio when transcript has no listen/nature cue.
 * Run after markPreserveAmbientSegments so cue-based marks are kept.
 * @returns {string[]} segmentIds cleared
 */
export function clearFalsePreserveAmbientFlags(recipe, { wordIndexes = null } = {}) {
  const cleared = [];

  for (const output of recipe?.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio !== true) {
        continue;
      }
      const transcript = collectSegmentTranscript(segment, wordIndexes);
      if (detectsIntentionalAmbientCue(transcript)) {
        continue;
      }
      delete segment.preserveAmbientAudio;
      cleared.push(segment.segmentId);
    }
  }

  return cleared;
}

function isAutoSpeechAcceptDecision(decision) {
  if (!decision || decision.action !== "accept") {
    return false;
  }
  return AUTO_SPEECH_ACCEPT_REASON_RE.test(decision.reason ?? "");
}

/**
 * Ensure reject decisions for clips used on preserveAmbientAudio segments.
 * - no decision → add reject
 * - auto/enrich accept → flip to reject
 * - director accept / other reject → leave decision; render still gates per-segment
 *
 * @returns {number} decisions added or flipped
 */
export function applyAmbientEnhancementRejects(recipe) {
  const preserveClipIds = new Set();
  for (const output of recipe?.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio === true) {
        const clipId = resolveSegmentClipId(segment);
        if (clipId) {
          preserveClipIds.add(clipId);
        }
      }
    }
  }
  if (!preserveClipIds.size) {
    return 0;
  }

  const decisions = [...(recipe.audioEnhancementDecisions ?? [])];
  const byClipId = new Map(decisions.map((d) => [d.clipId, d]));
  let changed = 0;

  for (const clipId of preserveClipIds) {
    const existing = byClipId.get(clipId);
    if (!existing) {
      decisions.push({
        candidateId: `enh_${clipId}`,
        clipId,
        action: "reject",
        dialogueValue: "useful",
        reason: INTENTIONAL_AMBIENT_REJECT_REASON,
        providerPreference: "auto",
        targetDialogueLufs: -18,
        retranscribePolicy: "never",
      });
      changed += 1;
      continue;
    }
    if (isAutoSpeechAcceptDecision(existing)) {
      existing.action = "reject";
      existing.reason = INTENTIONAL_AMBIENT_REJECT_REASON;
      changed += 1;
    }
  }

  recipe.audioEnhancementDecisions = decisions;
  return changed;
}

/**
 * Soft-disable silence_beat moments that overlap preserveAmbientAudio output ranges
 * (do not dip VO during bird/nature showcase).
 *
 * @returns {number} moments disabled
 */
export function softDisableSilenceBeatOnPreserveAmbient(recipe) {
  const rangesByOutput = new Map();
  for (const output of recipe?.outputs ?? []) {
    const ranges = [];
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio !== true) {
        continue;
      }
      const { start, end } = resolveSegmentOutputRange(segment);
      if (end > start) {
        ranges.push({ start, end });
      }
    }
    if (ranges.length) {
      rangesByOutput.set(output.outputId, ranges);
    }
  }
  if (!rangesByOutput.size || !recipe?.creativeMoments?.length) {
    return 0;
  }

  let disabled = 0;
  recipe.creativeMoments = recipe.creativeMoments.map((moment) => {
    if (moment.techniqueId !== "silence_beat" || moment.disabled === true) {
      return moment;
    }
    const ranges = rangesByOutput.get(moment.outputId);
    if (!ranges?.length) {
      return moment;
    }
    const mStart = moment.outputStartSec ?? 0;
    const mEnd = moment.outputEndSec ?? mStart;
    const overlaps = ranges.some(
      (range) => mStart < range.end && mEnd > range.start,
    );
    if (!overlaps) {
      return moment;
    }
    disabled += 1;
    return {
      ...moment,
      disabled: true,
      reason: `${moment.reason ?? "silence_beat"} [soft-disabled: intentional_ambient_preserve]`,
    };
  });
  return disabled;
}

/**
 * Split/replace ducking windows so ambient showcase ranges use duckingDb 0
 * without destroying speech ducks elsewhere.
 *
 * @param {{ startSec: number, endSec: number, duckingDb: number }[]} windows
 * @param {{ start: number, end: number }[]} showcaseRanges
 * @param {number} [showcaseDuckDb]
 */
export function mergeAmbientShowcaseDucking(
  windows,
  showcaseRanges,
  showcaseDuckDb = AMBIENT_SHOWCASE_DUCK_DB,
) {
  if (!showcaseRanges?.length) {
    return windows ?? [];
  }
  if (!windows?.length) {
    return showcaseRanges.map((range) => ({
      startSec: roundSec(range.start),
      endSec: roundSec(range.end),
      duckingDb: showcaseDuckDb,
    }));
  }

  const result = [];
  for (const window of windows) {
    let pieces = [{
      startSec: window.startSec,
      endSec: window.endSec,
      duckingDb: window.duckingDb,
    }];

    for (const range of showcaseRanges) {
      const next = [];
      for (const piece of pieces) {
        if (piece.endSec <= range.start || piece.startSec >= range.end) {
          next.push(piece);
          continue;
        }
        if (piece.startSec < range.start) {
          next.push({
            startSec: piece.startSec,
            endSec: roundSec(range.start),
            duckingDb: piece.duckingDb,
          });
        }
        const overlapStart = Math.max(piece.startSec, range.start);
        const overlapEnd = Math.min(piece.endSec, range.end);
        if (overlapEnd > overlapStart + 0.01) {
          next.push({
            startSec: roundSec(overlapStart),
            endSec: roundSec(overlapEnd),
            duckingDb: showcaseDuckDb,
          });
        }
        if (piece.endSec > range.end) {
          next.push({
            startSec: roundSec(range.end),
            endSec: piece.endSec,
            duckingDb: piece.duckingDb,
          });
        }
      }
      pieces = next;
    }
    result.push(...pieces);
  }

  return result
    .filter((w) => w.endSec > w.startSec + 0.01)
    .slice(0, 16);
}

/**
 * Apply duckingDb 0 under preserveAmbientAudio output windows.
 * @returns {number} mix segments updated
 */
export function applyAmbientShowcaseMusicDucking(recipe) {
  const plan = recipe?.audioMixPlan;
  if (!plan?.musicBed || !plan.segments?.length) {
    return 0;
  }

  const rangesByOutput = new Map();
  for (const output of recipe.outputs ?? []) {
    const ranges = [];
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio !== true) {
        continue;
      }
      const { start, end } = resolveSegmentOutputRange(segment);
      if (end > start) {
        ranges.push({ start, end });
      }
    }
    if (ranges.length) {
      rangesByOutput.set(output.outputId, ranges);
    }
  }
  if (!rangesByOutput.size) {
    return 0;
  }

  let updated = 0;
  for (const mixSegment of plan.segments) {
    if (mixSegment.duckUnderVoice === false) {
      continue;
    }
    const ranges = rangesByOutput.get(mixSegment.outputId);
    if (!ranges?.length) {
      continue;
    }
    const existing = mixSegment.duckingWindows ?? [];
    mixSegment.duckingWindows = mergeAmbientShowcaseDucking(existing, ranges);
    updated += 1;
  }
  return updated;
}

/**
 * Detect intentional ambient listen cues; mark segments, reject enhancement,
 * soft-disable silence_beat, and unduck music under showcase windows.
 *
 * @returns {{ markedSegments: string[], decisionsChanged: number, silenceBeatsDisabled: number, duckingUpdated: number }}
 */
export function enrichIntentionalAmbient(recipe, { wordIndexes = null } = {}) {
  const markedSegments = markPreserveAmbientSegments(recipe, { wordIndexes });
  clearFalsePreserveAmbientFlags(recipe, { wordIndexes });
  const decisionsChanged = applyAmbientEnhancementRejects(recipe);
  const silenceBeatsDisabled = softDisableSilenceBeatOnPreserveAmbient(recipe);
  const duckingUpdated = applyAmbientShowcaseMusicDucking(recipe);
  return {
    markedSegments,
    decisionsChanged,
    silenceBeatsDisabled,
    duckingUpdated,
  };
}
