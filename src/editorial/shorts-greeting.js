/**
 * Greeting / intro detection for shorts — shared by scene rank, enrichers, validators.
 */

export const GREETING_WORDS = new Set([
  "hej",
  "cześć",
  "czesc",
  "siema",
  "witam",
  "witaj",
  "hello",
  "hi",
  "hey",
  "yo",
  "elo",
]);

export const GREETING_PHRASE_PATTERNS = [
  /\bco\s+tam\b/i,
  /\bdzie[nń]\s+dobry\b/i,
  /\bdobry\s+(wiecz[oó]r|ranek)\b/i,
  /\bwhat'?s\s+up\b/i,
];

const SETUP_NARRATIVE_ROLES = new Set(["setup"]);

function normalizeWord(word) {
  return String(word ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * @param {string} word
 */
export function isGreetingWord(word) {
  const normalized = normalizeWord(word);
  if (!normalized) {
    return false;
  }
  if (GREETING_WORDS.has(normalized)) {
    return true;
  }
  return GREETING_PHRASE_PATTERNS.some((pattern) => pattern.test(String(word ?? "")));
}

/**
 * First non-filler word at or after sourceSec in clip word index.
 * @param {object} wordIndex
 * @param {number} sourceSec
 */
export function firstSpeechWordAtOrAfter(wordIndex, sourceSec = 0) {
  for (const word of wordIndex?.words ?? []) {
    if (word.isFiller) {
      continue;
    }
    if (word.end > sourceSec) {
      return word;
    }
  }
  return null;
}

/**
 * @param {object} wordIndex
 * @param {number} sourceSec
 */
export function segmentOpensWithGreeting(wordIndex, sourceSec = 0) {
  const first = firstSpeechWordAtOrAfter(wordIndex, sourceSec);
  if (!first) {
    return false;
  }
  if (isGreetingWord(first.word)) {
    return true;
  }
  const phrase = (wordIndex?.words ?? [])
    .filter((w) => !w.isFiller && w.start >= sourceSec && w.start < sourceSec + 4)
    .slice(0, 6)
    .map((w) => w.word)
    .join(" ");
  return GREETING_PHRASE_PATTERNS.some((pattern) => pattern.test(phrase));
}

/**
 * Find first substantive (non-greeting) word start after greetings in range.
 * @param {object} wordIndex
 * @param {number} sourceSec
 */
function countLeadingGreetingWords(words) {
  if (!words.length) {
    return 0;
  }

  for (let end = 1; end <= Math.min(words.length, 6); end += 1) {
    const phrase = words.slice(0, end).map((w) => w.word).join(" ");
    if (GREETING_PHRASE_PATTERNS.some((pattern) => pattern.test(phrase))) {
      return end;
    }
  }

  let count = 0;
  for (const word of words) {
    if (!isGreetingWord(word.word)) {
      break;
    }
    count += 1;
  }
  return count;
}

export function findSubstantiveWordStartSec(wordIndex, sourceSec = 0) {
  const words = (wordIndex?.words ?? []).filter((w) => !w.isFiller && w.end > sourceSec);
  if (!words.length) {
    return null;
  }

  const skipCount = countLeadingGreetingWords(words);
  if (skipCount > 0 && words[skipCount]) {
    return Math.max(sourceSec, words[skipCount].start);
  }

  for (const word of words) {
    if (word.start < sourceSec) {
      continue;
    }
    if (isGreetingWord(word.word)) {
      continue;
    }
    return Math.max(sourceSec, word.start);
  }

  return null;
}

/**
 * Prefer mid-sentence entry: after first comma/pause or at energy peak word.
 * @param {object} wordIndex
 * @param {number} sceneStartSec
 * @param {number} sceneEndSec
 */
export function resolveHookWordInpointSec(wordIndex, sceneStartSec, sceneEndSec) {
  const words = (wordIndex?.words ?? []).filter(
    (w) => !w.isFiller && w.start >= sceneStartSec && w.start < sceneEndSec,
  );
  if (!words.length) {
    return sceneStartSec;
  }

  const substantiveStart = findSubstantiveWordStartSec(wordIndex, sceneStartSec);
  const searchFrom = substantiveStart ?? sceneStartSec;

  for (const word of words) {
    if (word.start < searchFrom) {
      continue;
    }
    if (/[,—–-]/.test(String(word.word))) {
      const next = words.find((w) => w.start > word.end);
      if (next) {
        return next.start;
      }
    }
  }

  if (substantiveStart != null) {
    return substantiveStart;
  }

  const midIdx = Math.floor(words.length / 2);
  return words[midIdx]?.start ?? sceneStartSec;
}

/**
 * @param {string} sceneId
 * @param {object} abstraction
 */
export function isSetupNarrativeScene(sceneId, abstraction) {
  for (const segment of abstraction?.L2 ?? []) {
    if (!SETUP_NARRATIVE_ROLES.has(segment.narrativeRole)) {
      continue;
    }
    if ((segment.sceneIds ?? []).includes(sceneId)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} sceneId
 * @param {object} timelineIndex
 */
export function isChronologicalFirstScene(sceneId, timelineIndex) {
  const scenes = [...(timelineIndex?.scenes ?? [])].sort(
    (a, b) => (a.startSec ?? 0) - (b.startSec ?? 0) || a.sceneId.localeCompare(b.sceneId),
  );
  return scenes[0]?.sceneId === sceneId;
}

/**
 * @param {object} segment
 * @param {object[]} wordIndexes
 * @param {object} [timelineIndex]
 */
export function shortSegmentStartsWithIntro(segment, wordIndexes, timelineIndex = null) {
  const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
  const sceneId = segment.videoRef?.sceneId ?? segment.audioRef?.sceneId;
  const sourceIn = segment.audioInSec ?? segment.videoInSec ?? 0;

  if (sceneId && timelineIndex) {
    const scenes = [...(timelineIndex.scenes ?? [])].sort(
      (a, b) => (a.startSec ?? 0) - (b.startSec ?? 0),
    );
    const firstScene = scenes[0];
    if (firstScene?.sceneId === sceneId && sourceIn <= (firstScene.startSec ?? 0) + 0.5) {
      return true;
    }
  }

  const wordIndex = wordIndexes?.find((entry) => entry.clipId === clipId);
  if (wordIndex && segmentOpensWithGreeting(wordIndex, sourceIn)) {
    return true;
  }

  return false;
}
