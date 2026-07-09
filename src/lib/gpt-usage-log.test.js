import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createGptUsageTracker,
  createUsageRecorder,
  mergeGptUsageDocuments,
  parseOpenAIUsage,
  writeGptUsage,
} from "./gpt-usage-log.js";
import { ARTIFACTS } from "../pipeline/work-paths.js";

describe("gpt_usage_log", () => {
  it("parseOpenAIUsage reads prompt and completion tokens", () => {
    const parsed = parseOpenAIUsage({ prompt_tokens: 120, completion_tokens: 45 });
    assert.deepEqual(parsed, {
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
    });
  });

  it("createGptUsageTracker aggregates by step", () => {
    const tracker = createGptUsageTracker();
    const recordDirect = createUsageRecorder(tracker, "direct");
    recordDirect({
      model: "gpt-5.5-mini",
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    recordDirect({
      model: "gpt-5.5-mini",
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    tracker.record({
      step: "critic",
      model: "gpt-5.5-mini",
      usage: { prompt_tokens: 30, completion_tokens: 5 },
    });

    const summary = tracker.summary();
    assert.equal(summary.totals.calls, 3);
    assert.equal(summary.totals.promptTokens, 180);
    assert.equal(summary.steps.direct.calls, 2);
    assert.equal(summary.steps.critic.promptTokens, 30);
  });

  it("createUsageRecorder records super_critic step", () => {
    const tracker = createGptUsageTracker();
    const recordSuperCritic = createUsageRecorder(tracker, "super_critic");
    recordSuperCritic({
      model: "gpt-5.5-mini",
      usage: { prompt_tokens: 64, completion_tokens: 18 },
    });

    const summary = tracker.summary();
    assert.equal(summary.steps.super_critic.calls, 1);
    assert.equal(summary.steps.super_critic.promptTokens, 64);
    assert.equal(summary.steps.super_critic.completionTokens, 18);
  });

  it("writeGptUsage merges with existing artifact", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-gpt-usage-"));
    const tracker = createGptUsageTracker();
    tracker.record({
      step: "abstract",
      model: "gpt-5.5-nano",
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    writeGptUsage(workDir, tracker, { batchId: "batch01" });

    const second = createGptUsageTracker();
    second.record({
      step: "direct",
      model: "gpt-5.5-mini",
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    });
    const { document } = writeGptUsage(workDir, second, { batchId: "batch01" });

    assert.equal(document.records.length, 2);
    assert.equal(document.totals.promptTokens, 50);
    assert.ok(fs.existsSync(path.join(workDir, ARTIFACTS.gptUsage)));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("mergeGptUsageDocuments preserves prior records", () => {
    const merged = mergeGptUsageDocuments(
      { records: [{ step: "abstract", model: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }] },
      { records: [{ step: "direct", model: "m", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } }] },
      { batchId: "x" },
    );
    assert.equal(merged.records.length, 2);
    assert.equal(merged.totals.totalTokens, 6);
  });
});
