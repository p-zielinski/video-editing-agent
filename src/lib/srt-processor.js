const FILLER_WORDS = new Set([
  "yyy",
  "eee",
  "ooo",
  "mmm",
  "aha",
  "ach",
  "ej",
  "hm",
  "hmm",
  "ten",
  "um",
]);

const FILLER_PHRASES = ["no i"];

const HALLUCINATION_WINDOW_SEC = 40;
const HALLUCINATION_MIN_WORDS = 12;
const HALLUCINATION_MAX_VOCAB_RATIO = 0.38;
const HALLUCINATION_MAX_SCAN_SEC = 300;
const HALLUCINATION_SEGMENT_COMPRESSION = 2.35;
const HALLUCINATION_SEGMENT_LOGPROB = -0.5;

function normalizeWord(word) {
  return word.trim().replace(/\s+/g, " ");
}

export function wordCore(word) {
  return normalizeWord(word)
    .toLocaleLowerCase("pl-PL")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function isFillerWord(word) {
  const core = wordCore(word);
  return core.length > 0 && FILLER_WORDS.has(core);
}

function isFillerPhrase(words, index) {
  for (const phrase of FILLER_PHRASES) {
    const parts = phrase.split(/\s+/);
    if (parts.length === 1) {
      continue;
    }

    const slice = words
      .slice(index, index + parts.length)
      .map((entry) => wordCore(entry.word));

    if (slice.join(" ") === phrase) {
      return parts.length;
    }
  }

  return 0;
}

export function filterFillerWords(words) {
  const filtered = [];

  for (let index = 0; index < words.length; index += 1) {
    const phraseLength = isFillerPhrase(words, index);
    if (phraseLength > 0) {
      index += phraseLength - 1;
      continue;
    }

    if (!isFillerWord(words[index].word)) {
      filtered.push(words[index]);
    }
  }

  return filtered;
}

function meaningfulTokens(words) {
  return words
    .map((entry) => wordCore(entry.word ?? ""))
    .filter((token) => token.length > 2);
}

export function vocabularyRichness(words) {
  const tokens = meaningfulTokens(words);
  if (tokens.length === 0) {
    return 1;
  }

  return new Set(tokens).size / tokens.length;
}

function isRepetitiveHallucinationWindow(windowWords) {
  const tokens = meaningfulTokens(windowWords);
  const uniqueCount = new Set(tokens).size;
  const duration = windowWords.at(-1).end - windowWords[0].start;

  if (windowWords.length < HALLUCINATION_MIN_WORDS || duration < HALLUCINATION_WINDOW_SEC - 5) {
    return false;
  }

  if (vocabularyRichness(windowWords) < HALLUCINATION_MAX_VOCAB_RATIO) {
    return true;
  }

  return uniqueCount <= 14 && tokens.length >= 20;
}

export function findHallucinationPrefixEndSec(words, maxScanSec = HALLUCINATION_MAX_SCAN_SEC) {
  if (!Array.isArray(words) || words.length < HALLUCINATION_MIN_WORDS) {
    return 0;
  }

  const scanLimit = Math.min(maxScanSec, words.at(-1).end);
  let cutEndSec = 0;

  for (let windowStartSec = 0; windowStartSec < scanLimit; windowStartSec += 15) {
    const windowWords = words.filter(
      (entry) => entry.start >= windowStartSec && entry.start < windowStartSec + HALLUCINATION_WINDOW_SEC,
    );

    if (windowWords.length < HALLUCINATION_MIN_WORDS) {
      break;
    }

    const windowDuration = windowWords.at(-1).end - windowWords[0].start;
    if (windowDuration >= HALLUCINATION_WINDOW_SEC - 5 && isRepetitiveHallucinationWindow(windowWords)) {
      cutEndSec = Math.max(cutEndSec, windowWords.at(-1).end);
      continue;
    }

    break;
  }

  if (cutEndSec <= 0) {
    return 0;
  }

  const lexicon = new Set(
    meaningfulTokens(words.filter((entry) => entry.start >= cutEndSec - 60 && entry.start < cutEndSec)),
  );

  const tailWords = words.filter((entry) => entry.start >= cutEndSec - 0.05);
  for (let index = 0; index < tailWords.length; index += 1) {
    const probe = tailWords.slice(index, index + 10);
    const tokens = meaningfulTokens(probe);
    const novelTokens = tokens.filter((token) => !lexicon.has(token)).length;
    const firstToken = wordCore(probe[0]?.word ?? "");

    if (probe.length >= 6 && novelTokens >= 4 && firstToken && !lexicon.has(firstToken)) {
      return probe[0].start;
    }
  }

  return cutEndSec;
}

function isLikelyHallucinatedSegment(segment) {
  const compression = Number(segment.compression_ratio ?? 0);
  const logprob = Number(segment.avg_logprob ?? 0);
  return compression >= HALLUCINATION_SEGMENT_COMPRESSION && logprob <= HALLUCINATION_SEGMENT_LOGPROB;
}

function filterWordsByRejectedSegments(words, segments) {
  const rejected = segments.filter(isLikelyHallucinatedSegment);
  if (rejected.length === 0) {
    return words;
  }

  return words.filter((word) => {
    return !rejected.some(
      (segment) => word.start >= segment.start - 0.05 && word.end <= segment.end + 0.05,
    );
  });
}

export function stripHallucinationPrefix(words, maxScanSec = HALLUCINATION_MAX_SCAN_SEC) {
  if (!Array.isArray(words) || words.length === 0) {
    return words;
  }

  const cutEndSec = findHallucinationPrefixEndSec(words, maxScanSec);
  if (cutEndSec <= 0) {
    return words;
  }

  const filtered = words.filter((entry) => entry.start >= cutEndSec - 0.05);
  return filtered.length > 0 ? filtered : words;
}

export function cleanWhisperWords(words, segments = []) {
  const segmentFiltered =
    segments.length > 0 ? filterWordsByRejectedSegments(words, segments) : words;
  return stripHallucinationPrefix(segmentFiltered);
}

export function tagFillerWords(words) {
  return words.map((entry, index) => {
    const phraseLength = isFillerPhrase(words, index);
    const isFiller = phraseLength > 0 || isFillerWord(entry.word);
    return { ...entry, isFiller };
  });
}

export { tagProfanityWords } from "./profanity-censor.js";
