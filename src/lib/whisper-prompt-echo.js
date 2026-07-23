import { wordCore } from "./srt-processor.js";
import { WHISPER_EDIT_PROMPT } from "./transcribe.js";

const ALWAYS_DISTINCTIVE = new Set([
  "zapisz",
  "zapisuj",
  "każde",
  "zająknięciami",
  "eufemizmów",
  "cenzury",
  "transkrybuj",
  "dosłownie",
  "wulgaryzmy",
  "wulgaryzmów",
  "powtórek",
  "włącznie",
  "poprawiaj",
  "skracaj",
  "wypowiadane",
  "pisowni",
  "oczekiwane",
  "terminy",
]);

const SHORT_CONNECTOR_TOKENS = new Set([
  "z",
  "i",
  "w",
  "po",
  "co",
  "gdy",
  "ani",
  "bez",
  "nie",
  "hm",
  "um",
  "aha",
  "ach",
  "yyy",
  "eee",
  "ooo",
  "mmm",
]);

const MIN_PROMPT_RUN_LENGTH = 3;
const ISLAND_WINDOW = 8;
const ISLAND_MIN_DISTINCTIVE = 5;
const ISLAND_MIN_DENSITY = 0.62;

/**
 * @param {string} prompt
 * @returns {string[]}
 */
export function tokenizePrompt(prompt) {
  return String(prompt ?? "")
    .split(/\s+/)
    .map((token) => wordCore(token))
    .filter(Boolean);
}

/**
 * @param {string} token
 * @param {string[]} promptTokens
 * @param {number} [neighborIndex]
 * @returns {boolean}
 */
export function isDistinctivePromptToken(token, promptTokens, neighborIndex = -1) {
  if (!token) {
    return false;
  }
  if (token.length >= 4 || ALWAYS_DISTINCTIVE.has(token)) {
    return true;
  }
  if (token === "słowo" && neighborIndex >= 0) {
    const prev = promptTokens[neighborIndex - 1];
    const next = promptTokens[neighborIndex + 1];
    return prev === "każde" || prev === "zapisz" || next === "włącznie";
  }
  return false;
}

function buildPromptEchoContext(prompt = WHISPER_EDIT_PROMPT) {
  const promptTokens = tokenizePrompt(prompt);
  const promptTokenSet = new Set(promptTokens);
  const distinctiveSet = new Set();

  for (let index = 0; index < promptTokens.length; index += 1) {
    const token = promptTokens[index];
    if (isDistinctivePromptToken(token, promptTokens, index)) {
      distinctiveSet.add(token);
    }
  }

  return { promptTokens, promptTokenSet, distinctiveSet };
}

function findPromptTokenIndex(promptTokens, core, fromIndex = 0) {
  if (!core) {
    return -1;
  }

  for (let index = fromIndex; index < promptTokens.length; index += 1) {
    if (promptTokens[index] === core) {
      return index;
    }
  }

  for (let index = 0; index < fromIndex; index += 1) {
    if (promptTokens[index] === core) {
      return index;
    }
  }

  return -1;
}

function countDistinctiveInSlice(cores, start, end, distinctiveSet) {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (distinctiveSet.has(cores[index])) {
      count += 1;
    }
  }
  return count;
}

function markPromptOrderRuns(cores, context, marked) {
  const { promptTokens, promptTokenSet } = context;
  let runStart = -1;
  let runLength = 0;
  let promptIndex = 0;

  const flushRun = (runEnd) => {
    if (runLength < MIN_PROMPT_RUN_LENGTH) {
      return;
    }
    const distinctiveCount = countDistinctiveInSlice(
      cores,
      runStart,
      runEnd,
      context.distinctiveSet,
    );
    if (distinctiveCount < 2 && runLength < MIN_PROMPT_RUN_LENGTH + 1) {
      return;
    }
    for (let index = runStart; index < runEnd; index += 1) {
      marked.add(index);
    }
  };

  for (let index = 0; index < cores.length; index += 1) {
    const core = cores[index];
    if (!core || !promptTokenSet.has(core)) {
      flushRun(index);
      runStart = -1;
      runLength = 0;
      promptIndex = 0;
      continue;
    }

    const matchIndex = findPromptTokenIndex(promptTokens, core, promptIndex);
    if (matchIndex < 0) {
      flushRun(index);
      runStart = -1;
      runLength = 0;
      promptIndex = 0;
      continue;
    }

    if (runLength === 0) {
      runStart = index;
    }
    runLength += 1;
    promptIndex = matchIndex + 1;
    if (promptIndex >= promptTokens.length) {
      promptIndex = 0;
    }
  }

  flushRun(cores.length);
}

function markPromptTokenIslands(cores, context, marked) {
  const { promptTokenSet, distinctiveSet } = context;

  for (let start = 0; start < cores.length; start += 1) {
    const end = Math.min(cores.length, start + ISLAND_WINDOW);
    let promptHits = 0;
    let distinctiveHits = 0;

    for (let index = start; index < end; index += 1) {
      const core = cores[index];
      if (!core) {
        continue;
      }
      if (promptTokenSet.has(core)) {
        promptHits += 1;
      }
      if (distinctiveSet.has(core)) {
        distinctiveHits += 1;
      }
    }

    const windowLength = end - start;
    if (windowLength < MIN_PROMPT_RUN_LENGTH) {
      continue;
    }

    const density = promptHits / windowLength;
    if (distinctiveHits >= ISLAND_MIN_DISTINCTIVE && density >= ISLAND_MIN_DENSITY) {
      for (let index = start; index < end; index += 1) {
        marked.add(index);
      }
      start = end - 1;
    }
  }
}

/**
 * @param {object} word
 * @param {{ promptTokens?: string[], promptTokenSet?: Set<string>, distinctiveSet?: Set<string>, neighbors?: string[] }} [options]
 * @returns {boolean}
 */
export function isWhisperPromptEchoWord(word, options = {}) {
  const context = options.promptTokens
    ? {
      promptTokens: options.promptTokens,
      promptTokenSet: options.promptTokenSet ?? new Set(options.promptTokens),
      distinctiveSet: options.distinctiveSet
        ?? new Set(options.promptTokens.filter((token, index) =>
          isDistinctivePromptToken(token, options.promptTokens, index))),
    }
    : buildPromptEchoContext();

  const core = wordCore(word?.word ?? "");
  if (!core || !context.promptTokenSet.has(core)) {
    return false;
  }

  if (SHORT_CONNECTOR_TOKENS.has(core) && !context.distinctiveSet.has(core)) {
    const neighbors = options.neighbors ?? [];
    const neighborCores = neighbors.map((entry) => wordCore(entry?.word ?? entry ?? ""));
    const neighborPromptHits = neighborCores.filter((token) => context.promptTokenSet.has(token)).length;
    return neighborPromptHits >= 2;
  }

  if (context.distinctiveSet.has(core)) {
    return true;
  }

  const neighborIndex = context.promptTokens.indexOf(core);
  return isDistinctivePromptToken(core, context.promptTokens, neighborIndex);
}

/**
 * @param {object[]} words
 * @param {string} [prompt]
 * @returns {object[]}
 */
export function stripWhisperPromptEchoes(words, prompt = WHISPER_EDIT_PROMPT) {
  if (!Array.isArray(words) || words.length === 0) {
    return words ?? [];
  }

  const context = buildPromptEchoContext(prompt);
  const cores = words.map((entry) => wordCore(entry?.word ?? ""));
  const marked = new Set();

  markPromptOrderRuns(cores, context, marked);
  markPromptTokenIslands(cores, context, marked);

  if (marked.size === 0) {
    return words;
  }

  return words.filter((_, index) => !marked.has(index));
}

export { buildPromptEchoContext };
