import { lookupWordIndex } from "./audio-index-summary.js";
import { buildOutputTimeline, resolveWordIndexForSegment } from "../lib/build-output-timeline.js";
import { buildKeepRanges } from "../render/audio-cuts.js";

/** Deeper duck while speech is present (output timeline). */
export const SPEECH_DUCK_DB = -12;
/** Shallower / audible bed in speech gaps (not fully unducked). */
export const GAP_DUCK_DB = -4;
/** Merge word gaps shorter than this into one speech region. */
export const SPEECH_MERGE_GAP_SEC = 0.35;
/** Schema + validator cap for duckingWindows. */
export const MAX_DUCKING_WINDOWS = 16;

const EXTERNAL_OR_MUTE = new Set(["external", "mute", "from_prev", "from_next"]);

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

/**
 * Map a source-time instant to output seconds within one enriched segment.
 */
function sourceToOutputSec(sourceSec, segment, wordIndex) {
  const { audioIn, audioOut } = resolveSegmentRange(segment);
  const clamped = Math.min(Math.max(sourceSec, audioIn), audioOut);
  const outputStart = segment.outputStartSec ?? 0;

  if (!segment.cuts?.length || !wordIndex?.words?.length) {
    return outputStart + (clamped - audioIn);
  }

  const keepRanges = buildKeepRanges(segment.cuts, wordIndex, audioIn, audioOut);
  if (!keepRanges?.length) {
    return outputStart + (clamped - audioIn);
  }

  let outputOffset = 0;
  for (const range of keepRanges) {
    const rangeSourceStart = audioIn + range.start;
    const rangeSourceEnd = audioIn + range.end;
    if (clamped < rangeSourceStart) {
      break;
    }
    if (clamped <= rangeSourceEnd + 0.001) {
      return outputStart + outputOffset + Math.max(0, clamped - rangeSourceStart);
    }
    outputOffset += range.end - range.start;
  }

  return outputStart + outputOffset;
}

/**
 * Merge overlapping / near-adjacent [start,end] intervals.
 */
export function mergeIntervals(intervals, mergeGapSec = SPEECH_MERGE_GAP_SEC) {
  if (!intervals?.length) {
    return [];
  }

  const sorted = [...intervals]
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
    .sort((a, b) => a.start - b.start);

  if (!sorted.length) {
    return [];
  }

  const merged = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + mergeGapSec) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

function segmentCarriesDialogueAudio(segment) {
  if (EXTERNAL_OR_MUTE.has(segment.audioPolicy)) {
    return false;
  }
  if (segment.segmentRole === "broll" && segment.audioPolicy === "from_video_ref") {
    // B-roll with its own ambient track: usually not VO; skip unless audioRef differs.
    if (!segment.audioRef?.clipId || segment.audioRef.clipId === segment.videoRef?.clipId) {
      return false;
    }
  }
  return true;
}

/**
 * Collect speech intervals on the output timeline from wordIndexes.
 * @returns {{ start: number, end: number }[]}
 */
export function collectOutputSpeechIntervals(output, { wordIndexes = null } = {}) {
  if (!output?.timeline?.length) {
    return [];
  }

  const enriched = buildOutputTimeline(output, { wordIndexes });
  const intervals = [];

  for (const segment of enriched) {
    if (!segmentCarriesDialogueAudio(segment)) {
      continue;
    }

    const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
    if (!clipId) {
      continue;
    }

    const wordIndex = resolveWordIndexForSegment(segment, wordIndexes)
      ?? lookupWordIndex(clipId, wordIndexes, null);
    if (!wordIndex?.words?.length) {
      continue;
    }

    const { audioIn, audioOut } = resolveSegmentRange(segment);
    const words = wordIndex.words.filter(
      (word) => word.end > audioIn && word.start < audioOut,
    );

    for (const word of words) {
      const start = roundSec(sourceToOutputSec(Math.max(word.start, audioIn), segment, wordIndex));
      const end = roundSec(sourceToOutputSec(Math.min(word.end, audioOut), segment, wordIndex));
      if (end > start + 0.02) {
        intervals.push({ start, end });
      }
    }
  }

  return mergeIntervals(intervals).map((iv) => ({
    start: roundSec(iv.start),
    end: roundSec(iv.end),
  }));
}

function resolveSegmentEndSec(output, mixSegment) {
  if (Number.isFinite(mixSegment?.musicOutSec)) {
    return mixSegment.musicOutSec;
  }
  if (!output?.timeline?.length) {
    return null;
  }
  const enriched = buildOutputTimeline(output);
  return enriched.reduce((max, seg) => Math.max(max, seg.outputEndSec ?? 0), 0) || null;
}

/**
 * Coarsen speech regions until speech+gap window count fits MAX_DUCKING_WINDOWS.
 */
function coarsenSpeechRegions(speechRegions, endSec, maxWindows) {
  let regions = speechRegions.map((r) => ({ ...r }));
  let mergeGap = SPEECH_MERGE_GAP_SEC;

  const windowCount = (speech) => {
    if (!speech.length) {
      return endSec != null && endSec > 0 ? 1 : 0;
    }
    // speech + gaps (leading, between, trailing) ≈ 2*n+1, capped by coverage
    let count = speech.length;
    if (speech[0].start > 0) {
      count += 1;
    }
    if (endSec != null && speech[speech.length - 1].end < endSec) {
      count += 1;
    }
    count += Math.max(0, speech.length - 1);
    return count;
  };

  while (windowCount(regions) > maxWindows && regions.length > 1) {
    mergeGap += 0.5;
    regions = mergeIntervals(regions, mergeGap);
  }

  // Still over budget: keep the longest speech regions only.
  while (windowCount(regions) > maxWindows && regions.length > 1) {
    let dropIdx = 0;
    let dropDur = Infinity;
    for (let i = 0; i < regions.length; i += 1) {
      const dur = regions[i].end - regions[i].start;
      if (dur < dropDur) {
        dropDur = dur;
        dropIdx = i;
      }
    }
    regions.splice(dropIdx, 1);
    regions = mergeIntervals(regions, mergeGap);
  }

  return regions;
}

/**
 * Build full-coverage duckingWindows: speech → deep duck, gaps → shallow.
 *
 * @param {object} output - recipe output with timeline
 * @param {{ wordIndexes?: object[], speechDuckDb?: number, gapDuckDb?: number, endSec?: number|null, maxWindows?: number }} [options]
 * @returns {{ startSec: number, endSec: number, duckingDb: number }[]}
 */
export function deriveSpeechDuckingWindows(output, {
  wordIndexes = null,
  speechDuckDb = SPEECH_DUCK_DB,
  gapDuckDb = GAP_DUCK_DB,
  endSec = null,
  maxWindows = MAX_DUCKING_WINDOWS,
} = {}) {
  const resolvedEnd = endSec ?? resolveSegmentEndSec(output, null);
  let speech = collectOutputSpeechIntervals(output, { wordIndexes });

  if (!speech.length) {
    if (resolvedEnd != null && resolvedEnd > 0) {
      return [{ startSec: 0, endSec: roundSec(resolvedEnd), duckingDb: gapDuckDb }];
    }
    return [];
  }

  if (resolvedEnd != null) {
    speech = speech
      .map((r) => ({
        start: Math.max(0, r.start),
        end: Math.min(resolvedEnd, r.end),
      }))
      .filter((r) => r.end > r.start + 0.02);
  }

  speech = coarsenSpeechRegions(speech, resolvedEnd, maxWindows);

  const windows = [];
  let cursor = 0;

  for (const region of speech) {
    const start = roundSec(region.start);
    const end = roundSec(region.end);
    if (start > cursor + 0.02) {
      windows.push({ startSec: roundSec(cursor), endSec: start, duckingDb: gapDuckDb });
    }
    windows.push({ startSec: start, endSec: end, duckingDb: speechDuckDb });
    cursor = end;
  }

  if (resolvedEnd != null && cursor < resolvedEnd - 0.02) {
    windows.push({
      startSec: roundSec(cursor),
      endSec: roundSec(resolvedEnd),
      duckingDb: gapDuckDb,
    });
  }

  return windows.slice(0, maxWindows);
}

/**
 * Whether existing windows look like an intentional director override.
 * Single full-span window with one duckingDb is treated as non-intentional
 * (same as omitting windows — continuous duck).
 */
export function looksLikeIntentionalDuckingWindows(windows, { musicOutSec = null } = {}) {
  if (!Array.isArray(windows) || windows.length === 0) {
    return false;
  }
  if (windows.length >= 2) {
    return true;
  }
  const only = windows[0];
  if (only.startSec > 0.05) {
    return true;
  }
  if (musicOutSec != null && only.endSec != null && only.endSec < musicOutSec - 0.5) {
    return true;
  }
  return false;
}

/**
 * Fill missing / non-intentional duckingWindows from speech coverage.
 * Mutates recipe.audioMixPlan.segments in place.
 *
 * @returns {number} number of segments updated
 */
export function enrichRecipeSpeechDucking(recipe, { wordIndexes = null } = {}) {
  const plan = recipe?.audioMixPlan;
  if (!plan?.musicBed || !plan.segments?.length) {
    return 0;
  }

  const speechDuckDb = plan.musicBed.duckingDb ?? SPEECH_DUCK_DB;
  let updated = 0;

  for (const mixSegment of plan.segments) {
    if (mixSegment.duckUnderVoice === false) {
      continue;
    }
    if (looksLikeIntentionalDuckingWindows(mixSegment.duckingWindows, {
      musicOutSec: mixSegment.musicOutSec ?? null,
    })) {
      continue;
    }

    const output = (recipe.outputs ?? []).find((o) => o.outputId === mixSegment.outputId);
    if (!output?.timeline?.length) {
      continue;
    }

    const windows = deriveSpeechDuckingWindows(output, {
      wordIndexes,
      speechDuckDb: mixSegment.duckingDb ?? speechDuckDb,
      gapDuckDb: GAP_DUCK_DB,
      endSec: mixSegment.musicOutSec ?? null,
    });

    if (!windows.length) {
      continue;
    }

    mixSegment.duckingWindows = windows;
    updated += 1;
  }

  return updated;
}

/**
 * Clip IDs used as dialogue A-roll (or VO audioRef) with speech words on timeline.
 */
export function collectSpeechArollClipIds(recipe, { wordIndexes = null } = {}) {
  const clipIds = new Set();

  for (const output of recipe?.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.segmentRole === "broll" && !segment.audioRef?.clipId) {
        continue;
      }
      if (EXTERNAL_OR_MUTE.has(segment.audioPolicy)) {
        continue;
      }
      if (segment.segmentRole === "broll"
        && (!segment.audioRef?.clipId || segment.audioRef.clipId === segment.videoRef?.clipId)) {
        continue;
      }

      const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      if (!clipId) {
        continue;
      }

      const wordIndex = lookupWordIndex(clipId, wordIndexes, null);
      const { audioIn, audioOut } = resolveSegmentRange(segment);
      const hasSpeech = (wordIndex?.words ?? []).some(
        (word) => word.end > audioIn && word.start < audioOut,
      );
      if (hasSpeech) {
        clipIds.add(clipId);
      }
    }
  }

  return clipIds;
}

/**
 * Auto-accept enhancement for speech A-roll used in timeline.
 * Only adds decisions for clips with no existing entry; never overwrites
 * director `reject` (or any other existing decision). Does not touch non-speech clips.
 *
 * @returns {number} decisions added
 */
export function enrichAudioEnhancementSpeechAccepts(recipe, { wordIndexes = null } = {}) {
  const speechClips = collectSpeechArollClipIds(recipe, { wordIndexes });
  if (!speechClips.size) {
    return 0;
  }

  const preserveClipIds = new Set();
  for (const output of recipe?.outputs ?? []) {
    for (const segment of output.timeline ?? []) {
      if (segment.preserveAmbientAudio === true) {
        const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
        if (clipId) {
          preserveClipIds.add(clipId);
        }
      }
    }
  }

  const decisions = [...(recipe.audioEnhancementDecisions ?? [])];
  const byClipId = new Map(decisions.map((d) => [d.clipId, d]));
  let changed = 0;

  for (const clipId of speechClips) {
    if (byClipId.has(clipId) || preserveClipIds.has(clipId)) {
      continue;
    }

    decisions.push({
      candidateId: `enh_${clipId}`,
      clipId,
      action: "accept",
      dialogueValue: "useful",
      reason: "Auto-accept: speech A-roll used in timeline (DPDFNet ≠ music ducking)",
      providerPreference: "auto",
      targetDialogueLufs: -18,
      retranscribePolicy: "if_material_improvement",
    });
    changed += 1;
  }

  recipe.audioEnhancementDecisions = decisions;
  return changed;
}
