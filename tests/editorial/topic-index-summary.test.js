import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTopicIndexSummary } from "../../src/editorial/topic-index-summary.js";

describe("topic-index-summary", () => {
  it("returns undefined for empty topic index", () => {
    assert.equal(buildTopicIndexSummary({ topics: [] }), undefined);
    assert.equal(buildTopicIndexSummary(null), undefined);
  });

  it("includes matchingScenes with sceneId and score capped at 12", () => {
    const matchingScenes = Array.from({ length: 15 }, (_, i) => ({
      sceneId: `clip02_scene${String(i + 1).padStart(3, "0")}`,
      score: 0.5 + i * 0.01,
      reasons: ["a", "b", "c", "d"],
    }));
    const summary = buildTopicIndexSummary({
      topics: [{
        topicId: "t1",
        label: "test topic",
        matchingScenes,
      }],
    });

    assert.equal(summary.topicCount, 1);
    assert.equal(summary.topics[0].matchingScenes.length, 12);
    assert.equal(summary.topics[0].matchingScenes[0].sceneId, "clip02_scene001");
    assert.deepEqual(summary.topics[0].matchingScenes[0].reasons, ["a", "b", "c"]);
  });

  it("returns full topic fields when topic count is at most 15", () => {
    const summary = buildTopicIndexSummary({
      topics: [{
        topicId: "t1",
        label: "restaurant",
        keywords: ["food", "chef"],
        matchingScenes: [{ sceneId: "clip02_scene001", score: 0.9 }],
      }],
    });

    assert.deepEqual(summary.topics[0].keywords, ["food", "chef"]);
    assert.equal(summary.topics[0].topicId, "t1");
  });
});
