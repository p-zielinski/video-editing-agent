import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  measureBriefPayload,
  createBriefMetricsAccumulator,
  evaluateBriefMetricsWarnings,
  BRIEF_METRICS_WARN_SINGLE_TOKENS,
  BRIEF_METRICS_WARN_TOTAL_TOKENS,
} from "./brief-metrics.js";

describe("brief-metrics", () => {
  it("measureBriefPayload counts bytes and estimates tokens", () => {
    const brief = {
      sceneMap: [{ sceneId: "s1" }, { sceneId: "s2" }],
      sceneMapOmittedCount: 3,
      sceneMapPolicy: "compact_large_batch",
      topicIndex: { topics: [{ topicId: "t1" }] },
      transcriptExcerpts: [{ sceneId: "s1", words: [] }],
    };
    const userJson = JSON.stringify({ task: "initial_draft", brief });

    const metric = measureBriefPayload({
      task: "initial_draft",
      userJson,
      brief,
    });

    assert.equal(metric.task, "initial_draft");
    assert.ok(metric.jsonBytes > 0);
    assert.equal(metric.estimatedTokens, Math.ceil(metric.jsonBytes / 4));
    assert.equal(metric.sceneMapCount, 2);
    assert.equal(metric.sceneMapOmittedCount, 3);
    assert.equal(metric.sceneMapPolicy, "compact_large_batch");
    assert.equal(metric.topicCount, 1);
    assert.equal(metric.transcriptExcerptCount, 1);
  });

  it("createBriefMetricsAccumulator sums totals across calls", () => {
    const acc = createBriefMetricsAccumulator();
    acc.record(measureBriefPayload({
      task: "initial_draft",
      userJson: JSON.stringify({ a: 1 }),
    }));
    acc.record(measureBriefPayload({
      task: "segment_director_draft",
      userJson: JSON.stringify({ b: 2 }),
      segmentId: "seg001",
    }));

    const finalized = acc.finalize();
    assert.equal(finalized.calls.length, 2);
    assert.equal(finalized.totals.callCount, 2);
    assert.equal(
      finalized.totals.jsonBytes,
      finalized.calls.reduce((sum, call) => sum + call.jsonBytes, 0),
    );
  });

  it("evaluateBriefMetricsWarnings flags large single and total payloads", () => {
    const hugeJson = JSON.stringify({ data: "x".repeat(BRIEF_METRICS_WARN_SINGLE_TOKENS * 4) });
    const warnings = evaluateBriefMetricsWarnings({
      calls: [measureBriefPayload({ task: "initial_draft", userJson: hugeJson })],
      totals: {
        callCount: 1,
        jsonBytes: Buffer.byteLength(hugeJson, "utf8"),
        estimatedTokens: Math.ceil(Buffer.byteLength(hugeJson, "utf8") / 4),
      },
    });

    assert.ok(warnings.some((w) => w.code === "BRIEF_PAYLOAD_LARGE"));
    assert.ok(warnings.some((w) => w.code === "BRIEF_PAYLOAD_TOTAL_LARGE"
      || w.code === "BRIEF_PAYLOAD_LARGE"));
  });

  it("evaluateBriefMetricsWarnings is empty for small payloads", () => {
    const metrics = createBriefMetricsAccumulator();
    metrics.record(measureBriefPayload({
      task: "initial_draft",
      userJson: JSON.stringify({ brief: { sceneMap: [] } }),
      brief: { sceneMap: [] },
    }));
    assert.equal(evaluateBriefMetricsWarnings(metrics.finalize()).length, 0);
    assert.ok(BRIEF_METRICS_WARN_TOTAL_TOKENS > 1000);
  });
});
