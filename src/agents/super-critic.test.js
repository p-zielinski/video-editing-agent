import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSuperCritic } from "./super-critic.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";

const baseContext = () => {
  const recipe = {
    ...loadFixture("recipe-draft.json"),
    version: "2.4",
    creativeMoments: [],
  };
  return {
    recipe,
    superPlan: {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      crossSegmentNotes: ["callback: intro"],
      crossSegmentCallbacks: [],
      globalTheme: "vlog",
    },
    abstraction: loadFixture("abstraction.json"),
    partials: [{ segmentId: "seg001" }],
    timelineIndex: loadFixture("timeline-index.json"),
    topicIndex: { topics: [] },
    spatialIndex: { scenes: [] },
    audioIndex: null,
    perClipAnalysis: null,
    wordIndexes: [],
  };
};

describe("super-critic agent", () => {
  it("returns approved when model reports no errors", async () => {
    const client = createMockOpenAIClient([{
      approved: true,
      issues: [],
      summary: "Arc continuity looks good",
      crossSegmentNotes: [],
    }]);

    const review = await runSuperCritic(client, baseContext());

    assert.equal(review.approved, true);
    assert.equal(review.summary, "Arc continuity looks good");
    assert.deepEqual(review.issues, []);
    assert.deepEqual(review.crossSegmentNotes, []);
  });

  it("merges issues from model and rejects on error severity", async () => {
    const modelIssues = [
      {
        severity: "error",
        code: "SUPER-ARC-01",
        message: "Cold open lacks payoff in segment 2",
        segmentId: "seg002",
      },
      {
        severity: "warning",
        code: "SUPER-CALLBACK-01",
        message: "Weak callback thread",
      },
    ];
    const client = createMockOpenAIClient([{
      approved: true,
      issues: modelIssues,
      summary: "Cross-segment arc gaps",
      crossSegmentNotes: ["tighten callback in act 2"],
    }]);

    const review = await runSuperCritic(client, baseContext());

    assert.equal(review.approved, false);
    assert.equal(review.issues.length, 2);
    assert.ok(review.issues.some((issue) => issue.code === "SUPER-ARC-01"));
    assert.ok(review.issues.some((issue) => issue.code === "SUPER-CALLBACK-01"));
    assert.deepEqual(review.crossSegmentNotes, ["tighten callback in act 2"]);
  });

  it("calls onUsage when response includes token usage", async () => {
    const usageEvents = [];
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  approved: true,
                  issues: [],
                  summary: "ok",
                  crossSegmentNotes: [],
                }),
              },
            }],
            usage: { prompt_tokens: 80, completion_tokens: 12 },
          }),
        },
      },
    };

    await runSuperCritic(client, {
      ...baseContext(),
      onUsage: (event) => usageEvents.push(event),
    });

    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].usage.prompt_tokens, 80);
  });
});
