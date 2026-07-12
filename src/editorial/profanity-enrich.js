import { lookupWordIndex } from "./audio-index-summary.js";

function resolveSegmentRange(segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const audioOut = segment.audioOutSec ?? segment.videoOutSec ?? audioIn;
  return { audioIn, audioOut };
}

function resolveProfanityPolicy(batchContext = {}) {
  return batchContext.profanityPolicy ?? "bleep";
}

function wordsInSegmentRange(wordIndex, audioIn, audioOut) {
  return (wordIndex?.words ?? [])
    .filter((word) => word.end > audioIn && word.start < audioOut)
    .sort((a, b) => a.start - b.start);
}

function sourceToOutputSec(sourceSec, segment) {
  const audioIn = segment.audioInSec ?? segment.videoInSec ?? 0;
  const outputStart = segment.outputStartSec ?? 0;
  return outputStart + (sourceSec - audioIn);
}

function roundSec(value) {
  return Math.round(value * 1000) / 1000;
}

function resolveWordSafetyAction(word, profanityPolicy) {
  if (word.safetyAction && word.safetyAction !== "review") {
    return word.safetyClass === "profanity" ? profanityPolicy : word.safetyAction;
  }
  return word.isProfanity ? profanityPolicy : "allow";
}

function hasProfanityCut(segment, startWordId, endWordId) {
  return (segment.cuts ?? []).some(
    (cut) => cut.reason === "profanity"
      && cut.startWordId === startWordId
      && cut.endWordId === endWordId,
  );
}

function hasProfanityCensorship(segment, wordId, mode) {
  return (segment.audioCensorship ?? []).some(
    (window) => window.wordId === wordId && window.mode === mode,
  );
}

/**
 * Add profanity cuts or audio censorship windows based on batchContext policy.
 *
 * @param {object} recipe - EditRecipe v2 draft (mutated in place)
 * @param {object[]} [wordIndexes]
 * @param {object} [batchContext]
 * @returns {number} applied action count
 */
export function enrichRecipeProfanity(recipe, wordIndexes = null, batchContext = {}) {
  const policy = resolveProfanityPolicy(batchContext);
  if (policy === "off") {
    return 0;
  }

  const outputs = recipe.outputs ?? [];
  if (!outputs.length) {
    return 0;
  }

  let applied = 0;

  for (const output of outputs) {
    if (!output.timeline?.length) {
      continue;
    }

    for (const segment of output.timeline) {
      const clipId = segment.audioRef?.clipId ?? segment.videoRef?.clipId;
      const wordIndex = lookupWordIndex(clipId, wordIndexes, null);
      if (!wordIndex?.words?.length) {
        continue;
      }

      const { audioIn, audioOut } = resolveSegmentRange(segment);
      const profaneWords = wordsInSegmentRange(wordIndex, audioIn, audioOut)
        .filter((word) =>
          ["bleep", "mute", "cut", "mask"].includes(
            resolveWordSafetyAction(word, policy),
          ));

      for (const word of profaneWords) {
        const action = resolveWordSafetyAction(word, policy);
        if (action === "cut") {
          if (hasProfanityCut(segment, word.wordId, word.wordId)) {
            continue;
          }
          segment.cuts = [...(segment.cuts ?? []), {
            startWordId: word.wordId,
            endWordId: word.wordId,
            reason: "profanity",
          }];
          applied += 1;
          continue;
        }

        const mode = action === "mute" ? "mute" : "bleep";
        if (hasProfanityCensorship(segment, word.wordId, mode)) {
          continue;
        }

        const startSec = roundSec(sourceToOutputSec(Math.max(word.start, audioIn), segment));
        const endSec = roundSec(sourceToOutputSec(Math.min(word.end, audioOut), segment));
        if (endSec <= startSec) {
          continue;
        }

        segment.audioCensorship = [...(segment.audioCensorship ?? []), {
          startSec,
          endSec,
          mode,
          wordId: word.wordId,
        }];
        applied += 1;
      }
    }
  }

  return applied;
}
