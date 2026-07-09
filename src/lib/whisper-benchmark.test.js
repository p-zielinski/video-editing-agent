import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWordIndexFromWhisperResponse,
  evaluateWhisperCase,
  formatWhisperBenchmarkReport,
  listWhisperAuditCases,
  loadWhisperAuditCase,
  loadWhisperAuditCatalog,
  runWhisperBenchmark,
  scoreTokenRecall,
} from "./whisper-benchmark.js";
import { WordIndexSchema } from "../schemas/word-index.js";
import { wordCore } from "./srt-processor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("whisper benchmark fixture mode", () => {
  it("loads catalog with seven cases", () => {
    const catalog = loadWhisperAuditCatalog(REPO_ROOT);
    assert.equal(catalog.version, "1.0");
    assert.equal(catalog.cases.length, 7);
  });

  it("lists cases by category", () => {
    const profanity = listWhisperAuditCases({ category: "profanity", repoRoot: REPO_ROOT });
    assert.equal(profanity.length, 3);
  });

  it("buildWordIndexFromWhisperResponse matches WordIndexSchema", () => {
    const caseDef = loadWhisperAuditCase("profanity-literal", REPO_ROOT);
    const wordIndex = buildWordIndexFromWhisperResponse(caseDef.whisperResponse, caseDef.caseId);
    assert.doesNotThrow(() => WordIndexSchema.parse(wordIndex));
    assert.equal(wordIndex.clipId, "profanity-literal");
    assert.ok(wordIndex.words.length > 0);
  });

  it("scoreTokenRecall uses wordCore normalization", () => {
    const words = [{ word: "Kurwa,", start: 0, end: 0.5 }];
    const recall = scoreTokenRecall(words, ["kurwa", "serio"], { normalizeFn: wordCore });
    assert.equal(recall, 0.5);
  });

  it("evaluateWhisperCase passes profanity-literal fixture", () => {
    const caseDef = loadWhisperAuditCase("profanity-literal", REPO_ROOT);
    const wordIndex = buildWordIndexFromWhisperResponse(caseDef.whisperResponse, caseDef.caseId);
    const result = evaluateWhisperCase(caseDef, { words: wordIndex.words, mode: "fixture" });
    assert.equal(result.status, "pass");
    assert.equal(result.failures.length, 0);
  });

  it("evaluateWhisperCase reports failure codes", () => {
    const caseDef = loadWhisperAuditCase("profanity-literal", REPO_ROOT);
    const result = evaluateWhisperCase(caseDef, {
      words: [{ word: "cześć", start: 0, end: 0.5 }],
      mode: "fixture",
    });
    assert.equal(result.status, "fail");
    assert.ok(result.failures.some((failure) => failure.code === "MISSING_REQUIRED_TOKEN"));
    assert.ok(result.failures.some((failure) => failure.code === "TOKEN_RECALL_LOW"));
  });

  it("runWhisperBenchmark passes all fixture cases", async () => {
    const report = await runWhisperBenchmark({ mode: "fixture", repoRoot: REPO_ROOT });
    assert.equal(report.summary.total, 7);
    assert.equal(report.summary.pass, 7);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.pending, 0);
  });

  it("formatWhisperBenchmarkReport renders summary lines", async () => {
    const report = await runWhisperBenchmark({ mode: "fixture", repoRoot: REPO_ROOT });
    const text = formatWhisperBenchmarkReport(report);
    assert.match(text, /7 pass/);
    assert.match(text, /profanity-literal/);
  });
});
