import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tagFillerWords, tagProfanityWords, wordCore } from "./srt-processor.js";
import { applyExpectedTermCorrections } from "./transcript-correction.js";
import { assignWordIds, WordIndexSchema } from "../schemas/word-index.js";
import {
  wordsFromWhisperResponse,
  transcribeForEdit,
  WHISPER_EDIT_PROMPT,
  resolveOpenAIWhisperModel,
} from "./transcribe.js";

export const WHISPER_AUDIT_CATEGORIES = new Set([
  "profanity",
  "en-proper-nouns",
  "meta-commands",
]);

export const WHISPER_BENCHMARK_MODES = new Set(["fixture", "live", "record"]);

export function resolveWhisperAuditRoot(repoRoot = process.cwd()) {
  return path.join(repoRoot, "fixtures", "whisper-audit");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadWhisperAuditCatalog(repoRoot = process.cwd()) {
  const catalogPath = path.join(resolveWhisperAuditRoot(repoRoot), "catalog.json");
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Whisper audit catalog not found: ${catalogPath}`);
  }

  const catalog = readJson(catalogPath);
  if (!Array.isArray(catalog.cases) || catalog.cases.length === 0) {
    throw new Error("Whisper audit catalog must list at least one case");
  }

  return catalog;
}

export function listWhisperAuditCases({ category, caseIds, repoRoot = process.cwd() } = {}) {
  const catalog = loadWhisperAuditCatalog(repoRoot);
  let entries = catalog.cases;

  if (category) {
    entries = entries.filter((entry) => entry.category === category);
  }

  if (caseIds?.length) {
    const wanted = new Set(caseIds);
    entries = entries.filter((entry) => wanted.has(entry.caseId));
  }

  return entries;
}

export function loadWhisperAuditCase(caseId, repoRoot = process.cwd()) {
  const catalog = loadWhisperAuditCatalog(repoRoot);
  const entry = catalog.cases.find((item) => item.caseId === caseId);
  if (!entry) {
    throw new Error(`Unknown whisper audit case: ${caseId}`);
  }

  const caseDir = path.join(resolveWhisperAuditRoot(repoRoot), entry.dir);
  const caseDef = readJson(path.join(caseDir, "case.json"));
  const expected = readJson(path.join(caseDir, "expected.json"));

  const whisperResponsePath = path.join(caseDir, "whisper-response.json");
  const whisperResponse = fs.existsSync(whisperResponsePath)
    ? readJson(whisperResponsePath)
    : null;

  const audioFileName = caseDef.audio?.fileName ?? "audio.mp3";
  const audioPath = path.join(caseDir, audioFileName);
  const hasAudio = fs.existsSync(audioPath);

  return {
    ...entry,
    ...caseDef,
    expected,
    whisperResponse,
    whisperResponsePath,
    audioPath: hasAudio ? audioPath : null,
    caseDir,
  };
}

export function buildWordIndexFromWhisperResponse(transcription, clipId = "audit", options = {}) {
  const {
    expectedTerms = [],
    profanityPolicy = "bleep",
    profanitySubtitleMode = "partial",
  } = options;

  const raw = wordsFromWhisperResponse(transcription);
  const tagged = tagFillerWords(raw);
  const profanityTagged = tagProfanityWords(tagged, {
    profanityPolicy,
    subtitleMode: profanitySubtitleMode,
  });
  const corrected = applyExpectedTermCorrections(profanityTagged, expectedTerms);
  const withIds = assignWordIds(corrected, clipId);

  return WordIndexSchema.parse({
    version: "1.0",
    clipId,
    words: withIds,
    durationSec: transcription.duration ?? withIds.at(-1)?.end ?? 1,
  });
}

function tokenizeWords(words, normalizeFn = wordCore) {
  return words
    .map((entry) => normalizeFn(entry.word ?? ""))
    .filter((token) => token.length > 0);
}

function tokenizeTranscript(transcript, normalizeFn = wordCore) {
  return transcript
    .split(/\s+/)
    .map((token) => normalizeFn(token))
    .filter((token) => token.length > 0);
}

export function scoreTokenRecall(actualWords, expectedTokens, { normalizeFn = wordCore } = {}) {
  const actual = tokenizeWords(actualWords, normalizeFn);
  const expected = expectedTokens.map((token) => normalizeFn(token)).filter(Boolean);

  if (expected.length === 0) {
    return 1;
  }

  const actualSet = new Set(actual);
  const matched = expected.filter((token) => actualSet.has(token)).length;
  return matched / expected.length;
}

function hasOrderedSubsequence(actualTokens, requiredTokens, normalizeFn = wordCore) {
  const normalizedRequired = requiredTokens.map((token) => normalizeFn(token)).filter(Boolean);
  if (normalizedRequired.length === 0) {
    return true;
  }

  let requiredIndex = 0;
  for (const token of actualTokens) {
    if (token === normalizedRequired[requiredIndex]) {
      requiredIndex += 1;
      if (requiredIndex >= normalizedRequired.length) {
        return true;
      }
    }
  }

  return false;
}

function transcriptFromWords(words) {
  return words.map((entry) => entry.word ?? "").join(" ").trim();
}

function includesToken(actualTokens, token, normalizeFn = wordCore) {
  const normalized = normalizeFn(token);
  return normalized.length > 0 && actualTokens.includes(normalized);
}

function includesAnyToken(actualTokens, alternatives, normalizeFn = wordCore) {
  return alternatives.some((token) => includesToken(actualTokens, token, normalizeFn));
}

function includesPhrase(actualTokens, phrase, normalizeFn = wordCore) {
  const parts = phrase
    .split(/\s+/)
    .map((token) => normalizeFn(token))
    .filter(Boolean);

  if (parts.length === 0) {
    return true;
  }

  if (parts.length === 1) {
    return includesToken(actualTokens, parts[0], normalizeFn);
  }

  for (let index = 0; index <= actualTokens.length - parts.length; index += 1) {
    const slice = actualTokens.slice(index, index + parts.length);
    if (slice.every((token, offset) => token === parts[offset])) {
      return true;
    }
  }

  return false;
}

export function evaluateWhisperCase(caseDef, { words, mode = "fixture", model, prompt } = {}) {
  const failures = [];
  const actualTokens = tokenizeWords(words ?? []);
  const actualTranscript = transcriptFromWords(words ?? []);
  const expected = caseDef.expected ?? {};

  if (!Array.isArray(words) || words.length === 0) {
    if (!expected.allowEmptyWords) {
      failures.push({
        code: "EMPTY_WORDS",
        message: "Whisper returned no words after post-processing",
      });
    }
  }

  const expectedTokens = tokenizeTranscript(caseDef.spokenTranscript ?? "");
  const tokenRecall = scoreTokenRecall(words ?? [], expectedTokens);
  const minRecall = expected.minTokenRecall ?? 0;

  if (tokenRecall < minRecall) {
    failures.push({
      code: "TOKEN_RECALL_LOW",
      message: `Token recall ${tokenRecall.toFixed(2)} below minimum ${minRecall}`,
    });
  }

  for (const token of expected.mustIncludeTokens ?? []) {
    if (!includesToken(actualTokens, token)) {
      failures.push({
        code: "MISSING_REQUIRED_TOKEN",
        message: `Missing required token: ${token}`,
      });
    }
  }

  for (const alternatives of expected.mustIncludeAny ?? []) {
    if (!includesAnyToken(actualTokens, alternatives)) {
      failures.push({
        code: "MISSING_REQUIRED_TOKEN",
        message: `Missing any of: ${alternatives.join(", ")}`,
      });
    }
  }

  for (const token of expected.mustNotIncludeTokens ?? []) {
    if (includesToken(actualTokens, token)) {
      failures.push({
        code: "FORBIDDEN_TOKEN",
        message: `Forbidden token present: ${token}`,
      });
    }
  }

  if (expected.orderedSubsequence?.length) {
    if (!hasOrderedSubsequence(actualTokens, expected.orderedSubsequence)) {
      failures.push({
        code: "MISSING_REQUIRED_TOKEN",
        message: `Ordered subsequence not found: ${expected.orderedSubsequence.join(" ")}`,
      });
    }
  }

  for (const token of expected.preserveEnglishTokens ?? []) {
    if (!includesToken(actualTokens, token)) {
      failures.push({
        code: "MISSING_REQUIRED_TOKEN",
        message: `English token not preserved: ${token}`,
      });
    }
  }

  for (const token of expected.forbidPolishPhonetic ?? []) {
    if (includesToken(actualTokens, token)) {
      failures.push({
        code: "EN_PROPER_NOUN_POLISHIFIED",
        message: `Polish phonetic variant detected: ${token}`,
      });
    }
  }

  for (const phrase of expected.metaPhrases ?? []) {
    const value = phrase.value ?? phrase.text ?? "";
    if (value && !includesPhrase(actualTokens, value)) {
      failures.push({
        code: "META_PHRASE_MISSING",
        message: `Meta phrase missing (${phrase.type ?? "unknown"}): ${value}`,
      });
    }
  }

  const status = failures.length === 0 ? "pass" : "fail";

  return {
    caseId: caseDef.caseId,
    category: caseDef.category,
    status,
    mode,
    model: model ?? resolveOpenAIWhisperModel(),
    prompt: prompt ?? WHISPER_EDIT_PROMPT,
    tokenRecall,
    failures,
    actualTranscript,
    expectedTranscript: caseDef.spokenTranscript,
  };
}

function promptFingerprint(prompt) {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

async function resolveWordsForCase(caseDef, { mode, apiKey, prompt }) {
  if (mode === "fixture") {
    if (!caseDef.whisperResponse) {
      return { status: "pending", words: null, reason: "MISSING_FIXTURE" };
    }

    const wordIndex = buildWordIndexFromWhisperResponse(caseDef.whisperResponse, caseDef.caseId);
    return { status: "evaluated", words: wordIndex.words };
  }

  if (!apiKey) {
    return { status: "skipped", words: null, reason: "MISSING_API_KEY" };
  }

  if (!caseDef.audioPath) {
    return { status: "skipped", words: null, reason: "MISSING_AUDIO" };
  }

  const result = await transcribeForEdit(caseDef.audioPath, apiKey, { prompt, returnRaw: true });
  const wordIndex = buildWordIndexFromWhisperResponse(result.raw, caseDef.caseId);

  if (mode === "record" && caseDef.whisperResponsePath) {
    fs.writeFileSync(caseDef.whisperResponsePath, `${JSON.stringify(result.raw, null, 2)}\n`);
  }

  return { status: "evaluated", words: wordIndex.words };
}

export async function runWhisperBenchmark({
  mode = "fixture",
  repoRoot = process.cwd(),
  caseIds,
  category,
  apiKey = process.env.OPENAI_API_KEY,
  prompt = WHISPER_EDIT_PROMPT,
  outputPath,
  failOnRegression = false,
  includePending = true,
} = {}) {
  if (!WHISPER_BENCHMARK_MODES.has(mode)) {
    throw new Error(`Invalid benchmark mode: ${mode}`);
  }

  const entries = listWhisperAuditCases({ category, caseIds, repoRoot });
  const cases = [];

  for (const entry of entries) {
    const caseDef = loadWhisperAuditCase(entry.caseId, repoRoot);
    const resolved = await resolveWordsForCase(caseDef, { mode, apiKey, prompt });

    if (resolved.status === "pending") {
      cases.push({
        caseId: caseDef.caseId,
        category: caseDef.category,
        status: "pending",
        mode,
        failures: [{ code: "MISSING_FIXTURE", message: "whisper-response.json not found" }],
        actualTranscript: "",
        expectedTranscript: caseDef.spokenTranscript,
        tokenRecall: 0,
      });
      continue;
    }

    if (resolved.status === "skipped") {
      cases.push({
        caseId: caseDef.caseId,
        category: caseDef.category,
        status: "skipped",
        mode,
        failures: [{ code: resolved.reason, message: resolved.reason }],
        actualTranscript: "",
        expectedTranscript: caseDef.spokenTranscript,
        tokenRecall: 0,
      });
      continue;
    }

    cases.push(evaluateWhisperCase(caseDef, {
      words: resolved.words,
      mode,
      model: resolveOpenAIWhisperModel(),
      prompt,
    }));
  }

  const visibleCases = includePending ? cases : cases.filter((item) => item.status !== "pending");
  const summary = {
    total: visibleCases.length,
    pass: visibleCases.filter((item) => item.status === "pass").length,
    fail: visibleCases.filter((item) => item.status === "fail").length,
    pending: visibleCases.filter((item) => item.status === "pending").length,
    skipped: visibleCases.filter((item) => item.status === "skipped").length,
  };

  const report = {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    mode,
    whisperModel: resolveOpenAIWhisperModel(),
    promptVariant: "default",
    promptFingerprint: promptFingerprint(prompt),
    summary,
    cases: visibleCases,
    failOnRegression,
  };

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
}

export function formatWhisperBenchmarkReport(report) {
  const lines = [
    `Whisper benchmark (${report.mode}) — ${report.generatedAt}`,
    `Model: ${report.whisperModel} | Prompt: ${report.promptFingerprint}`,
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.pending} pending, ${report.summary.skipped} skipped (${report.summary.total} total)`,
    "",
  ];

  for (const caseResult of report.cases) {
    const marker = caseResult.status === "pass"
      ? "PASS"
      : caseResult.status === "fail"
        ? "FAIL"
        : caseResult.status.toUpperCase();
    lines.push(`[${marker}] ${caseResult.caseId} (${caseResult.category}) recall=${caseResult.tokenRecall?.toFixed?.(2) ?? "0.00"}`);

    if (caseResult.failures?.length) {
      for (const failure of caseResult.failures) {
        lines.push(`  - ${failure.code}: ${failure.message}`);
      }
    }
  }

  return lines.join("\n");
}
