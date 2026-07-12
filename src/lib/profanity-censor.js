import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wordCore } from "./srt-processor.js";
import { chatJson, MODELS } from "../agents/openai-client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_LIST_PATH = path.join(ROOT, "config", "profanity-pl.json");
const DEFAULT_SAFETY_PATH = path.join(
  ROOT,
  "config",
  "safety",
  "content-safety-pl.json",
);

let cachedList = null;
let cachedSafetyConfig = null;

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

export function loadContentSafetyConfig(configPath = DEFAULT_SAFETY_PATH) {
  if (cachedSafetyConfig && configPath === DEFAULT_SAFETY_PATH) {
    return cachedSafetyConfig;
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (configPath === DEFAULT_SAFETY_PATH) {
    cachedSafetyConfig = config;
  }
  return config;
}

export function isProfanityWord(word, list = loadProfanityList()) {
  const normalized = normalizeProfanityToken(word);
  return normalized.length > 0 && list.words.has(normalized);
}

function matchProfanityPhrase(words, index, list) {
  for (const phrase of list.phrases) {
    const parts = phrase.split(/\s+/);
    if (parts.length === 1) {
      continue;
    }

    const slice = words
      .slice(index, index + parts.length)
      .map((entry) => normalizeProfanityToken(entry.word ?? ""));

    if (slice.join(" ") === phrase) {
      return parts;
    }
  }

  return null;
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
  return tagContentSafetyWords(words, options);
}

function matchesConfiguredRoot(token, { root, minLength = root.length }) {
  return token.length >= minLength && token.startsWith(root);
}

const INFLECTION_SUFFIXES = new Set([
  "",
  "a",
  "ami",
  "ach",
  "em",
  "ie",
  "in",
  "ina",
  "inem",
  "ini",
  "om",
  "owie",
  "ów",
  "ow",
  "ska",
  "ski",
  "skie",
  "ską",
  "ska",
  "y",
  "ydem",
  "ydzi",
]);

function matchesIdentityRoot(token, root) {
  if (!token.startsWith(root)) {
    return false;
  }
  return INFLECTION_SUFFIXES.has(token.slice(root.length));
}

function findTaxonomyMatch(token, groups, matcher = (value, root) => value.startsWith(root)) {
  for (const group of groups ?? []) {
    const root = (group.roots ?? []).find((entry) => matcher(token, entry));
    if (root) {
      return { id: group.id, root };
    }
  }
  return null;
}

function hasHatefulCue(normalizedWords, index, config) {
  const start = Math.max(0, index - 4);
  const end = Math.min(normalizedWords.length, index + 5);
  const context = normalizedWords.slice(start, end);
  return context.some((token) => (config.hatefulAttackCues ?? []).includes(token));
}

function applyDisplayWord(entry, action, subtitleMode) {
  if (!["bleep", "mute", "cut", "mask"].includes(action) || subtitleMode === "off") {
    const copy = { ...entry };
    delete copy.displayWord;
    return copy;
  }
  return {
    ...entry,
    displayWord: censorWordForDisplay(entry.word, subtitleMode),
  };
}

export function tagContentSafetyWords(words, options = {}) {
  const list = options.list ?? loadProfanityList();
  const safetyConfig = options.safetyConfig ?? loadContentSafetyConfig();
  const subtitleMode = resolveSubtitleMode(options);
  const profanityMatched = new Set();
  const normalizedWords = words.map((entry) => normalizeProfanityToken(entry.word ?? ""));

  for (let index = 0; index < words.length; index += 1) {
    const parts = matchProfanityPhrase(words, index, list);
    if (parts) {
      let taggedAny = false;
      for (let offset = 0; offset < parts.length; offset += 1) {
        const tokenIndex = index + offset;
        const token = normalizedWords[tokenIndex];
        const rootMatch = (safetyConfig.profanityRoots ?? []).some((root) =>
          matchesConfiguredRoot(token, root));
        if (list.words.has(token) || rootMatch) {
          profanityMatched.add(tokenIndex);
          taggedAny = true;
        }
      }
      if (!taggedAny) {
        profanityMatched.add(index + parts.length - 1);
      }
    }
  }

  return words.map((entry, index) => {
    const normalizedWord = normalizedWords[index];
    const rootProfanity = (safetyConfig.profanityRoots ?? []).some((root) =>
      matchesConfiguredRoot(normalizedWord, root));
    const isProfanity = profanityMatched.has(index)
      || isProfanityWord(entry.word, list)
      || rootProfanity;
    let enriched = {
      ...entry,
      normalizedWord: entry.normalizedWord ?? normalizedWord,
      isProfanity,
    };

    if (isProfanity) {
      const action = (options.profanityPolicy ?? "bleep") === "off"
        ? "allow"
        : (options.profanityPolicy ?? "bleep");
      enriched = {
        ...enriched,
        safetyClass: "profanity",
        safetyAction: action,
        safetyReason: "profanity_match",
        safetyConfidence: 1,
      };
      return applyDisplayWord(enriched, action, subtitleMode);
    }

    if (options.brandSafetyEnabled === false) {
      return enriched;
    }

    const identity = findTaxonomyMatch(
      normalizedWord,
      safetyConfig.protectedIdentityRoots,
      matchesIdentityRoot,
    );
    if (identity) {
      const hateful = hasHatefulCue(normalizedWords, index, safetyConfig);
      enriched = {
        ...enriched,
        safetyClass: hateful ? "hateful_attack" : "protected_identity",
        safetyAction: hateful ? "bleep" : "allow",
        safetyReason: hateful
          ? `hateful_context:${identity.id}`
          : `neutral_identity:${identity.id}`,
        safetyConfidence: hateful ? 0.95 : 1,
      };
      return applyDisplayWord(enriched, enriched.safetyAction, subtitleMode);
    }

    const sensitive = findTaxonomyMatch(
      normalizedWord,
      safetyConfig.sensitiveRoots,
    );
    if (sensitive) {
      return {
        ...enriched,
        safetyClass: "sensitive",
        safetyAction: "review",
        safetyReason: `ambiguous_sensitive:${sensitive.id}`,
        safetyConfidence: 0.5,
        safetyDefaultAction: "bleep",
      };
    }

    return enriched;
  });
}

function buildAmbiguousCandidates(words) {
  return words.flatMap((word, index) => {
    if (word.safetyAction !== "review") {
      return [];
    }
    const context = words
      .slice(Math.max(0, index - 6), Math.min(words.length, index + 7))
      .map((entry) => entry.word)
      .join(" ");
    return [{
      candidateId: `safety_${index}`,
      token: word.word,
      safetyClass: word.safetyClass,
      context,
    }];
  });
}

function applySafetyDecision(word, decision, subtitleMode) {
  const action = decision?.action === "allow" ? "allow" : "bleep";
  const resolved = {
    ...word,
    safetyAction: action,
    safetyReason: decision?.reason ?? "classifier_fallback",
    safetyConfidence: Number.isFinite(decision?.confidence)
      ? Math.max(0, Math.min(1, decision.confidence))
      : 0.5,
  };
  delete resolved.safetyDefaultAction;
  return applyDisplayWord(resolved, action, subtitleMode);
}

export async function resolveAmbiguousSafetyContexts(words, {
  client,
  subtitleMode = "partial",
  onUsage,
} = {}) {
  const candidates = buildAmbiguousCandidates(words);
  if (candidates.length === 0) {
    return words;
  }

  let decisions = [];
  if (client) {
    try {
      const response = await chatJson(client, {
        model: MODELS.safetyClassifier ?? "gpt-5.4-mini",
        temperature: 0,
        system: [
          "Classify only the supplied Polish sensitive-term candidates.",
          "allow = neutral, educational, documentary, quoted, condemning, or necessary factual context.",
          "bleep = sensational, accusatory, glorifying, threatening, hateful, or context is insufficient.",
          "Never classify a candidate ID that was not supplied.",
          "Return JSON: {\"decisions\":[{\"candidateId\":\"safety_0\",\"action\":\"allow|bleep\",\"reason\":\"short_code\",\"confidence\":0-1}]}",
        ].join(" "),
        user: JSON.stringify({ candidates }),
        onUsage,
      });
      decisions = Array.isArray(response?.decisions) ? response.decisions : [];
    } catch {
      decisions = [];
    }
  }

  const byId = new Map(
    decisions
      .filter((decision) =>
        candidates.some((candidate) => candidate.candidateId === decision.candidateId)
        && ["allow", "bleep"].includes(decision.action))
      .map((decision) => [decision.candidateId, decision]),
  );

  return words.map((word, index) => {
    if (word.safetyAction !== "review") {
      return word;
    }
    return applySafetyDecision(word, byId.get(`safety_${index}`), subtitleMode);
  });
}

function tokenizeSafetyText(text) {
  const tokens = [];
  const matcher = /[\p{L}\p{N}]+/gu;
  for (const match of text.matchAll(matcher)) {
    tokens.push({
      word: match[0],
      startChar: match.index,
      endChar: match.index + match[0].length,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export function classifyTextSafety(text, {
  brandSafetyEnabled = true,
  mode = "partial",
} = {}) {
  const config = loadContentSafetyConfig();
  const rawTokens = tokenizeSafetyText(String(text ?? ""));
  const tagged = tagContentSafetyWords(rawTokens, {
    brandSafetyEnabled,
    profanityPolicy: "bleep",
    subtitleMode: mode,
  });
  const normalized = rawTokens.map((entry) => normalizeProfanityToken(entry.word));
  const hasEducationalContext = normalized.some(
    (token) => (config.educationalCues ?? []).includes(token),
  );

  return tagged.map((entry) => {
    if (entry.safetyAction !== "review") {
      return entry;
    }
    return applySafetyDecision(entry, hasEducationalContext
      ? {
          action: "allow",
          reason: "deterministic_educational_context",
          confidence: 0.85,
        }
      : {
          action: "bleep",
          reason: "deterministic_sensitive_fallback",
          confidence: 0.7,
        }, mode);
  });
}

export function sanitizeTextForSafety(text, {
  mode = "partial",
  brandSafetyEnabled = true,
} = {}) {
  const source = String(text ?? "");
  if (!source || mode === "off") {
    return source;
  }
  const classified = classifyTextSafety(source, { mode, brandSafetyEnabled });
  const replacements = classified
    .filter((entry) => entry.safetyAction !== "allow" && entry.displayWord)
    .sort((a, b) => b.startChar - a.startChar);

  let result = source;
  for (const entry of replacements) {
    result = `${result.slice(0, entry.startChar)}${entry.displayWord}${result.slice(entry.endChar)}`;
  }
  return result;
}
