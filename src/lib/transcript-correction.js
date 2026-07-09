import { wordCore } from "./srt-processor.js";

const KNOWN_POLISH_MISHEARS = new Map([
  ["eldyn", "elden"],
  ["brejking", "breaking"],
]);

const PHONETIC_SUBSTITUTIONS = [
  [/en/g, "yn"],
  [/ea/g, "ej"],
  [/oo/g, "u"],
  [/ee/g, "i"],
];

function canonicalTokenForms(expectedTerms) {
  const forms = [];

  for (const term of expectedTerms) {
    for (const part of String(term).split(/\s+/).filter(Boolean)) {
      forms.push({
        canonical: part,
        core: wordCore(part),
      });
    }
  }

  return forms;
}

export function polishMishearVariants(canonicalCore) {
  const variants = new Set([canonicalCore]);

  for (const [pattern, replacement] of PHONETIC_SUBSTITUTIONS) {
    pattern.lastIndex = 0;
    if (pattern.test(canonicalCore)) {
      pattern.lastIndex = 0;
      variants.add(canonicalCore.replace(pattern, replacement));
    }
  }

  for (const [mishear, canonical] of KNOWN_POLISH_MISHEARS) {
    if (wordCore(canonical) === canonicalCore) {
      variants.add(mishear);
    }
  }

  return variants;
}

export function buildVariantMap(expectedTerms) {
  const map = new Map();

  for (const { canonical, core } of canonicalTokenForms(expectedTerms)) {
    for (const variant of polishMishearVariants(core)) {
      if (variant !== core) {
        map.set(variant, canonical);
      }
    }
  }

  for (const [mishear, canonical] of KNOWN_POLISH_MISHEARS) {
    if (!map.has(mishear)) {
      map.set(mishear, canonical);
    }
  }

  return map;
}

export function applyExpectedTermCorrections(words, expectedTerms = []) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  if (!expectedTerms?.length) {
    return words.map((entry) => ({
      ...entry,
      normalizedWord: entry.normalizedWord ?? wordCore(entry.word),
    }));
  }

  const variantMap = buildVariantMap(expectedTerms);

  return words.map((entry) => {
    const normalized = wordCore(entry.word);
    const correction = variantMap.get(normalized);
    const corrected = correction && correction !== entry.word
      ? { ...entry, word: correction }
      : entry;

    return {
      ...corrected,
      normalizedWord: corrected.normalizedWord ?? wordCore(corrected.word),
    };
  });
}
