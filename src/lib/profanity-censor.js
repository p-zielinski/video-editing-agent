import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wordCore } from "./srt-processor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_LIST_PATH = path.join(ROOT, "config", "profanity-pl.json");

let cachedList = null;

/**
 * Collapse runs of 3+ identical characters (kuuurwa → kurwa).
 */
export function normalizeProfanityToken(word) {
  return wordCore(word).replace(/(.)\1{2,}/g, "$1");
}

/**
 * Censor a single token for subtitle display.
 * partial: kurwa → k***a; short words (≤2 chars) → **
 * full: all asterisks matching word length
 */
export function censorWordForDisplay(word, mode = "partial") {
  const core = normalizeProfanityToken(word);
  if (!core) {
    return word;
  }

  if (mode === "full") {
    return "*".repeat(Math.max(2, core.length));
  }

  if (core.length <= 2) {
    return "**";
  }

  const middle = "*".repeat(Math.max(1, core.length - 2));
  return `${core[0]}${middle}${core[core.length - 1]}`;
}

export function loadProfanityList(listPath = DEFAULT_LIST_PATH) {
  if (cachedList && listPath === DEFAULT_LIST_PATH) {
    return cachedList;
  }

  const raw = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const words = new Set((raw.words ?? []).map((entry) => normalizeProfanityToken(entry)));
  const phrases = (raw.phrases ?? []).map((phrase) =>
    phrase.split(/\s+/).map((part) => normalizeProfanityToken(part)).join(" "),
  );

  const list = { words, phrases };
  if (listPath === DEFAULT_LIST_PATH) {
    cachedList = list;
  }
  return list;
}

export function isProfanityWord(word, list = loadProfanityList()) {
  const normalized = normalizeProfanityToken(word);
  return normalized.length > 0 && list.words.has(normalized);
}

function isProfanityPhrase(words, index, list) {
  for (const phrase of list.phrases) {
    const parts = phrase.split(/\s+/);
    if (parts.length === 1) {
      continue;
    }

    const slice = words
      .slice(index, index + parts.length)
      .map((entry) => normalizeProfanityToken(entry.word ?? ""));

    if (slice.join(" ") === phrase) {
      return parts.length;
    }
  }

  return 0;
}

function resolveSubtitleMode(options = {}) {
  const policy = options.profanityPolicy ?? "bleep";
  if (policy === "off") {
    return "off";
  }
  return options.subtitleMode ?? options.profanitySubtitleMode ?? "partial";
}

/**
 * Tag words with profanity metadata for downstream censorship and subtitles.
 */
export function tagProfanityWords(words, options = {}) {
  const list = options.list ?? loadProfanityList();
  const subtitleMode = resolveSubtitleMode(options);
  const phraseMatched = new Set();

  for (let index = 0; index < words.length; index += 1) {
    const phraseLength = isProfanityPhrase(words, index, list);
    if (phraseLength > 0) {
      for (let offset = 0; offset < phraseLength; offset += 1) {
        phraseMatched.add(index + offset);
      }
    }
  }

  return words.map((entry, index) => {
    const normalizedWord = normalizeProfanityToken(entry.word);
    const isProfanity = phraseMatched.has(index) || isProfanityWord(entry.word, list);
    const enriched = {
      ...entry,
      normalizedWord: entry.normalizedWord ?? normalizedWord,
      isProfanity,
    };

    if (isProfanity && subtitleMode !== "off") {
      enriched.displayWord = censorWordForDisplay(entry.word, subtitleMode);
    }

    return enriched;
  });
}
