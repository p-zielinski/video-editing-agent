import {
  buildOutputTimeline,
  resolveWordIndexForSegment,
} from "../lib/build-output-timeline.js";

const MIN_OVERLAP_SEC = 0.3;
const MAX_OVERLAP_SEC = 3;
const DEFAULT_FPS = 30;
const WORD_BOUNDARY_WINDOW_SEC = 0.6;

export function snapToFrameSec(sec, fps = DEFAULT_FPS) {
  if (!Number.isFinite(sec)) {
    return sec;
  }
  return Math.round(sec * fps) / fps;
}

function clampOverlap(sec) {
  return Math.min(MAX_OVERLAP_SEC, Math.max(MIN_OVERLAP_SEC, sec));
}

function nearestWordBoundarySec(words, sourceSec) {
  let best = null;
  let bestDist = Infinity;
  for (const word of words ?? []) {
    for (const boundary of [word.start, word.end]) {
      if (!Number.isFinite(boundary)) {
        continue;
      }
      const dist = Math.abs(boundary - sourceSec);
      if (dist <= WORD_BOUNDARY_WINDOW_SEC && dist < bestDist) {
        bestDist = dist;
        best = boundary;
      }
    }
  }
  return best;
}

/**
 * Snap J/L overlap to nearest word boundary at the join, then quantize to frame.
 */
export function snapJlCutOverlapSec(prevSeg, seg, wordIndexes, { fps = DEFAULT_FPS } = {}) {
  const rawOverlap = seg?.overlapSec ?? prevSeg?.overlapSec ?? 0;
  if (rawOverlap <= 0) {
    return rawOverlap;
  }

  if (seg?.audioPolicy === "from_prev" && prevSeg) {
    const wordIndex = resolveWordIndexForSegment(prevSeg, wordIndexes);
    const joinSourceSec = prevSeg.audioOutSec ?? prevSeg.videoOutSec ?? 0;
    const boundary = nearestWordBoundarySec(wordIndex?.words, joinSourceSec);
    if (boundary == null) {
      return snapToFrameSec(rawOverlap, fps);
    }
    const snapped = clampOverlap(joinSourceSec - boundary);
    return snapToFrameSec(snapped, fps);
  }

  if (seg?.audioPolicy === "from_next") {
    const wordIndex = resolveWordIndexForSegment(seg, wordIndexes);
    const joinSourceSec = seg.audioInSec ?? seg.videoInSec ?? 0;
    const boundary = nearestWordBoundarySec(wordIndex?.words, joinSourceSec);
    if (boundary == null) {
      return snapToFrameSec(rawOverlap, fps);
    }
    const snapped = clampOverlap(boundary - joinSourceSec);
    return snapToFrameSec(snapped, fps);
  }

  return snapToFrameSec(rawOverlap, fps);
}

/**
 * Deterministically snap overlapSec on timeline segments with J/L policies.
 */
export function enrichRecipeJlCutSnap(recipe, wordIndexes, options = {}) {
  if (!wordIndexes?.length) {
    return recipe;
  }

  for (const output of recipe.outputs ?? []) {
    const enriched = buildOutputTimeline(output, { wordIndexes });
    for (let i = 0; i < enriched.length; i += 1) {
      const seg = enriched[i];
      const raw = output.timeline.find((entry) => entry.segmentId === seg.segmentId);
      if (!raw || !(raw.overlapSec > 0)) {
        continue;
      }
      if (raw.audioPolicy !== "from_prev" && raw.audioPolicy !== "from_next") {
        continue;
      }

      const prev = i > 0 ? enriched[i - 1] : null;
      const snapped = snapJlCutOverlapSec(prev, seg, wordIndexes, options);
      if (Math.abs(snapped - raw.overlapSec) > 0.001) {
        raw.jlCutSnapMeta = {
          originalOverlapSec: raw.overlapSec,
          snappedOverlapSec: snapped,
        };
        raw.overlapSec = snapped;
      } else if (snapped !== raw.overlapSec) {
        raw.overlapSec = snapped;
      }
    }
  }

  return recipe;
}
