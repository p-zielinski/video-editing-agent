/**
 * Build FFmpeg audio filter chain applying word-level cuts within a segment range.
 * Returns filter_complex fragment ending with [aout].
 */

function sortCutsByWordStart(cuts, wordMap) {
  return [...cuts].sort((a, b) => {
    const wa = wordMap.get(a.startWordId);
    const wb = wordMap.get(b.startWordId);
    return (wa?.start ?? 0) - (wb?.start ?? 0);
  });
}

/**
 * Shared keep-ranges for audio and video splice within [rangeStartSec, rangeEndSec].
 * Returns offsets relative to rangeStartSec, or null when cuts/wordIndex are absent.
 */
export function buildKeepRanges(cuts, wordIndex, rangeStartSec, rangeEndSec) {
  if (!cuts?.length || !wordIndex?.words?.length) {
    return null;
  }

  const wordMap = new Map(wordIndex.words.map((w) => [w.wordId, w]));
  const keepRanges = [];
  let cursor = rangeStartSec;

  for (const cut of sortCutsByWordStart(cuts, wordMap)) {
    if (cut.keepIfStoryCritical) {
      continue;
    }
    const startWord = wordMap.get(cut.startWordId);
    const endWord = wordMap.get(cut.endWordId);
    if (!startWord || !endWord) {
      continue;
    }
    const cutStart = Math.max(rangeStartSec, startWord.start);
    const cutEnd = Math.min(rangeEndSec, endWord.end);
    if (cutStart > cursor + 0.01) {
      keepRanges.push({ start: cursor - rangeStartSec, end: cutStart - rangeStartSec });
    }
    cursor = Math.max(cursor, cutEnd);
  }

  if (cursor < rangeEndSec - 0.01) {
    keepRanges.push({ start: cursor - rangeStartSec, end: rangeEndSec - rangeStartSec });
  }

  return keepRanges;
}

export function applyAudioCutsToRange({
  audioFilter = "[1:a]anull",
  cuts = [],
  wordIndex,
  rangeStartSec,
  rangeEndSec,
  singleInput = false,
}) {
  const keepRanges = buildKeepRanges(cuts, wordIndex, rangeStartSec, rangeEndSec);
  if (!keepRanges) {
    const base = singleInput ? "[0:a]anull" : audioFilter;
    return `${base}[aout]`;
  }

  const inputLabel = singleInput ? "[0:a]" : audioFilter.replace(/\[aout\]$/, "");

  if (keepRanges.length === 0) {
    return `${inputLabel}anull[aout]`;
  }

  const parts = keepRanges.map((range, i) => {
    return `${inputLabel}atrim=${range.start}:${range.end},asetpts=PTS-STARTPTS[a${i}]`;
  });

  const concatInputs = keepRanges.map((_, i) => `[a${i}]`).join("");
  return `${parts.join(";")};${concatInputs}concat=n=${keepRanges.length}:v=0:a=1[aout]`;
}

/**
 * Video splice matching audio cuts — trim+concat on the video stream (segment-relative).
 */
export function applyVideoCutsToRange({
  videoLabel = "[0:v]",
  cuts = [],
  wordIndex,
  rangeStartSec,
  rangeEndSec,
}) {
  const keepRanges = buildKeepRanges(cuts, wordIndex, rangeStartSec, rangeEndSec);
  if (!keepRanges) {
    return `${videoLabel}setpts=PTS-STARTPTS[vout]`;
  }

  if (keepRanges.length === 0) {
    return `${videoLabel}null[vout]`;
  }

  const parts = keepRanges.map((range, i) => {
    return `${videoLabel}trim=start=${range.start}:end=${range.end},setpts=PTS-STARTPTS[v${i}]`;
  });

  const concatInputs = keepRanges.map((_, i) => `[v${i}]`).join("");
  return `${parts.join(";")};${concatInputs}concat=n=${keepRanges.length}:v=1:a=0[vout]`;
}

export function findWordById(wordIndex, wordId) {
  return wordIndex?.words?.find((w) => w.wordId === wordId) ?? null;
}

/**
 * Total seconds removed by word-level cuts within [rangeStartSec, rangeEndSec].
 * Uses the same cursor logic as buildKeepRanges (no double-count on overlaps).
 */
export function computeCutsRemovedSec(cuts, wordIndex, rangeStartSec, rangeEndSec) {
  const keepRanges = buildKeepRanges(cuts, wordIndex, rangeStartSec, rangeEndSec);
  if (!keepRanges) {
    return 0;
  }

  const span = rangeEndSec - rangeStartSec;
  const kept = keepRanges.reduce((sum, range) => sum + (range.end - range.start), 0);
  return Math.round(Math.max(0, span - kept) * 1000) / 1000;
}
