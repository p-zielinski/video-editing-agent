import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyModelPool,
  createDailyQuotaTracker,
  estimateChatTokens,
  formatQuotaDateKey,
  summarizeByModel,
} from "./openai-daily-usage.js";

describe("openai-daily-usage", () => {
  /** @type {string | null} */
  let tempDir = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-daily-usage-"));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("classifyModelPool maps chat models to premium or mini pools", () => {
    assert.equal(classifyModelPool("gpt-5.4"), "premium");
    assert.equal(classifyModelPool("gpt-4o"), "premium");
    assert.equal(classifyModelPool("gpt-5.4-mini"), "mini");
    assert.equal(classifyModelPool("gpt-5.4-nano"), "mini");
    assert.equal(classifyModelPool("gpt-4o-mini"), "mini");
    assert.equal(classifyModelPool("whisper-1"), "paidOther");
    assert.equal(classifyModelPool("text-embedding-3-small"), "paidOther");
    assert.equal(classifyModelPool("gpt-4o-mini-audio-preview"), "paidOther");
  });

  it("estimateChatTokens uses conservative chars/3.5 plus output reserve", () => {
    const estimate = estimateChatTokens({
      system: "a".repeat(350),
      user: "b".repeat(350),
      role: "director",
    });
    assert.ok(estimate >= 200);
  });

  it("creates a new daily document for the current date", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.pools.premium.usedTokens, 0);
    assert.equal(snapshot.limits.premium, 250000);
    assert.equal(snapshot.limits.mini, 2500000);
  });

  it("reserve and commit update pool usage", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    const callId = "call-1";
    tracker.reserve({
      callId,
      role: "director",
      step: "direct",
      model: "gpt-5.4",
      estimatedTokens: 10000,
    });
    let snapshot = tracker.snapshot();
    assert.equal(snapshot.pools.premium.reservedTokens, 10000);

    tracker.commit({
      callId,
      model: "gpt-5.4",
      usage: { prompt_tokens: 8000, completion_tokens: 1200, total_tokens: 9200 },
      step: "direct",
      batchId: "batch01",
    });
    snapshot = tracker.snapshot();
    assert.equal(snapshot.pools.premium.usedTokens, 9200);
    assert.equal(snapshot.pools.premium.reservedTokens, 0);
    assert.equal(snapshot.models["gpt-5.4"].totalTokens, 9200);
  });

  it("release clears reservation on failure", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    const callId = "call-2";
    tracker.reserve({
      callId,
      role: "critic",
      step: "critic",
      model: "gpt-5.4-mini",
      estimatedTokens: 5000,
    });
    tracker.release({ callId, reason: "error" });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.pools.mini.reservedTokens, 0);
    assert.equal(snapshot.pools.mini.usedTokens, 0);
  });

  it("markPoolExhausted blocks further premium reservations", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    tracker.markPoolExhausted({ pool: "premium", reason: "insufficient_quota" });
    assert.throws(
      () => tracker.reserve({
        callId: "call-3",
        role: "director",
        step: "direct",
        model: "gpt-5.4",
        estimatedTokens: 1000,
      }),
      /premium pool exhausted/i,
    );
  });

  it("persists usage to disk and reloads it", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    const callId = "call-4";
    tracker.reserve({
      callId,
      role: "summarizerL1",
      step: "abstract",
      model: "gpt-5.4-nano",
      estimatedTokens: 1000,
    });
    tracker.commit({
      callId,
      model: "gpt-5.4-nano",
      usage: { prompt_tokens: 700, completion_tokens: 100, total_tokens: 800 },
      step: "abstract",
      batchId: "batch01",
    });

    const dateKey = formatQuotaDateKey(new Date(), "UTC");
    const filePath = path.join(tempDir, "daily", `${dateKey}.json`);
    assert.ok(fs.existsSync(filePath));

    const reloaded = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch02",
    });
    const snapshot = reloaded.snapshot();
    assert.equal(snapshot.pools.mini.usedTokens, 800);
    assert.equal(snapshot.batches.batch01.calls, 1);
  });

  it("duplicate callId does not double-count usage", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    const payload = {
      callId: "call-dup",
      model: "gpt-5.4-mini",
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      step: "critic",
      batchId: "batch01",
    };
    tracker.reserve({
      callId: payload.callId,
      role: "critic",
      step: "critic",
      model: "gpt-5.4-mini",
      estimatedTokens: 120,
    });
    tracker.commit(payload);
    tracker.commit(payload);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.totals.calls, 1);
    assert.equal(snapshot.pools.mini.usedTokens, 120);
  });

  it("summarizeByModel aggregates records by model", () => {
    const summary = summarizeByModel([
      { model: "gpt-5.4", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
      { model: "gpt-5.4", usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } },
      { model: "gpt-5.4-mini", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
    ]);
    assert.equal(summary["gpt-5.4"].calls, 2);
    assert.equal(summary["gpt-5.4"].totalTokens, 18);
    assert.equal(summary["gpt-5.4-mini"].totalTokens, 4);
  });

  it("recordPaidUsage tracks whisper and embeddings separately", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
    });
    tracker.recordPaidUsage({
      type: "whisper",
      model: "whisper-1",
      audioSeconds: 42,
      step: "transcribe",
      batchId: "batch01",
    });
    tracker.recordPaidUsage({
      type: "embedding",
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 120, total_tokens: 120 },
      step: "topic_index",
      batchId: "batch01",
    });
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.pools.paidOther.calls, 2);
    assert.equal(snapshot.pools.paidOther.audioSeconds, 42);
    assert.equal(snapshot.pools.paidOther.inputTokens, 120);
  });

  it("accumulates usage from multiple batches on the same day", () => {
    const batchA = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch-a",
    });
    const callA = "call-a";
    batchA.reserve({
      callId: callA,
      role: "director",
      step: "direct",
      model: "gpt-5.4",
      estimatedTokens: 500,
    });
    batchA.commit({
      callId: callA,
      model: "gpt-5.4",
      usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 },
      step: "direct",
      batchId: "batch-a",
    });

    const batchB = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch-b",
    });
    const callB = "call-b";
    batchB.reserve({
      callId: callB,
      role: "critic",
      step: "review",
      model: "gpt-5.4-mini",
      estimatedTokens: 200,
    });
    batchB.commit({
      callId: callB,
      model: "gpt-5.4-mini",
      usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
      step: "review",
      batchId: "batch-b",
    });

    const snapshot = batchB.snapshot();
    assert.equal(snapshot.totals.totalTokens, 700);
    assert.equal(snapshot.pools.premium.usedTokens, 500);
    assert.equal(snapshot.pools.mini.usedTokens, 200);
    assert.equal(snapshot.batches["batch-a"].calls, 1);
    assert.equal(snapshot.batches["batch-b"].calls, 1);
    assert.equal(snapshot.batches["batch-a"].premiumTokens, 500);
    assert.equal(snapshot.batches["batch-b"].miniTokens, 200);
  });

  it("emits warnings when usage crosses configured thresholds", () => {
    const tracker = createDailyQuotaTracker({
      usageDir: tempDir,
      timezone: "UTC",
      batchId: "batch01",
      warnPercents: [50],
      limits: { premium: 1000, mini: 10000 },
    });
    const warnings = [];
    tracker.onWarn = (warning) => warnings.push(warning);
    const callId = "call-warn";
    tracker.reserve({ callId, role: "director", step: "direct", model: "gpt-5.4", estimatedTokens: 600 });
    tracker.commit({
      callId,
      model: "gpt-5.4",
      usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600 },
      step: "direct",
      batchId: "batch01",
    });
    assert.ok(warnings.some((warning) => warning.pool === "premium" && warning.percent >= 50));
  });
});
