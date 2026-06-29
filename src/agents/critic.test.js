import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { heuristicReview, runCritic } from "./critic.js";
import { runFixer } from "./fixer.js";
import { validateTimelineSegments } from "../validators/scene-registry.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";

const audioIndex = {
  version: "1.0",
  batchId: "testbatch",
  clips: [{
    clipId: "clip01",
    beatCount: 2,
    beatTimes: [0.5, 1.0],
  }],
};

describe("critic agent", () => {
  it("surfaces heuristic validation issues without API call", () => {
    const recipe = {
      version: "1.0",
      batchId: "b1",
      batchContext: { qualityOverQuantity: true },
      outputs: [
        {
          outputId: "h1",
          format: "16:9",
          title: "Main",
          timeline: [
            {
              segmentId: "s1",
              sourceRef: { clipId: "clip01", sceneId: "clip01_scene001" },
              videoInSec: 10,
              videoOutSec: 5,
            },
          ],
        },
      ],
      excluded: [],
      sceneUsageRegistry: [],
    };

    const segmentIssues = validateTimelineSegments(recipe);
    assert.ok(segmentIssues.some((i) => i.code === "INVALID_SEGMENT_RANGE"));

    const heuristicIssues = heuristicReview(recipe, { requiredFormats: ["16:9"] });
    assert.ok(heuristicIssues.some((i) => i.code === "INVALID_SEGMENT_RANGE"));
  });

  it("merges model review with heuristics via mocked OpenAI", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [
        {
          momentId: "cm_001",
          techniqueId: "cut_on_beat",
          outputId: "horizontal_main",
          outputStartSec: 10,
          outputEndSec: 10.1,
          segmentId: "seg_h1",
          reason: "Test beat",
        },
      ],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const criticResponse = loadFixture("critic-response.json");
    const spatialIndex = {
      version: "1.0",
      batchId: "testbatch",
      scenes: [
        {
          sceneId: "clip01_scene001",
          anchors: [{
            type: "subject",
            bbox: [0.2, 0.25, 0.4, 0.5],
            timestampSec: 5,
            label: "person",
            confidence: 0.8,
          }],
        },
      ],
    };

    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });
    const review = await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      spatialIndex,
      iteration: 1,
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(review.approved, true);
    assert.equal(review.iteration, 1);
    assert.equal(review.summary, criticResponse.summary);

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.spatialIndex.scenes.length, 1);
    assert.equal(payload.spatialIndex.scenes[0].sceneId, "clip01_scene001");
    assert.ok(payload.techniqueCatalog);
    assert.equal(payload.techniqueCatalogSummary, undefined);
  });

  it("fixes recipe via mocked OpenAI", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [
        {
          momentId: "cm_001",
          techniqueId: "cut_on_beat",
          outputId: "horizontal_main",
          outputStartSec: 10,
          outputEndSec: 10.1,
          segmentId: "seg_h1",
          reason: "Test beat",
        },
      ],
    };
    const abstraction = loadFixture("abstraction.json");
    const fixerResponse = loadFixture("fixer-response.json");
    const topicIndex = {
      version: "1.0",
      batchId: "testbatch",
      topics: [
        {
          topicId: "topic_001",
          label: "vlog",
          wordIds: ["clip01_w0001"],
          timeRange: { clipId: "clip01", startSec: 0, endSec: 30 },
          matchingScenes: [{ sceneId: "clip01_scene002", score: 0.8 }],
        },
      ],
    };
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "TEST", message: "test issue" }],
      summary: "needs fix",
    };

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    const fixed = await runFixer(client, {
      recipe,
      review,
      abstraction,
      topicIndex,
      timelineIndex: loadFixture("timeline-index.json"),
      audioIndex,
    });

    assert.equal(fixed.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(fixed.batchId, "testbatch");

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.topicIndex.topicCount, 1);
    assert.equal(payload.topicIndex.topics[0].topicId, "topic_001");
    assert.equal(payload.topicIndex.topics[0].matchingScenes[0].sceneId, "clip01_scene002");
    assert.equal(payload.topicIndex.topics[0].matchingScenes[0].score, 0.8);
  });

  it("critic payload includes transcriptExcerpts per scene and audioIndex", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const criticResponse = loadFixture("critic-response.json");
    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });

    await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      audioIndex,
      iteration: 1,
      requiredFormats: ["16:9", "9:16"],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    const excerpts = payload.timelineCrossCheck.transcriptExcerpts;
    assert.equal(excerpts.length, 2);
    assert.equal(excerpts[0].sceneId, "clip01_scene001");
    assert.equal(excerpts[0].words[0].wordId, "clip01_w001");
    assert.deepEqual(payload.timelineCrossCheck.audioIndex.clips[0].beatTimestamps, [0.5, 1.0]);
    assert.equal(payload.timelineCrossCheck.topicIndex, undefined);
  });

  it("critic payload includes rich topicIndex with matchingScenes", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const topicIndex = {
      version: "1.0",
      batchId: "testbatch",
      topics: [{
        topicId: "topic_001",
        label: "vlog",
        matchingScenes: [
          { sceneId: "clip01_scene002", score: 0.8, reasons: ["visual match"] },
        ],
      }],
    };
    const criticResponse = loadFixture("critic-response.json");
    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });

    await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      topicIndex,
      iteration: 1,
      requiredFormats: ["16:9", "9:16"],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.topicIndex.topics[0].matchingScenes[0].sceneId, "clip01_scene002");
  });

  it("critic payload includes retention context when shorts retention applies", async () => {
    const base = loadFixture("recipe-draft.json");
    const recipe = {
      ...base,
      version: "2.2",
      batchContext: {
        ...base.batchContext,
        requiredFormats: ["16:9", "9:16"],
      },
      outputs: [
        ...base.outputs,
        {
          outputId: "short_9x16",
          format: "9:16",
          outputKind: "short",
          title: "Short",
          timeline: base.outputs[0].timeline,
        },
      ],
      shortsRetentionProfile: { enabled: true },
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const criticResponse = loadFixture("critic-response.json");
    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });

    await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      iteration: 1,
      requiredFormats: ["9:16"],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.ok(payload.shortsRetentionProfile);
    assert.equal(payload.shortsRetentionProfile.enabled, true);
    assert.ok(payload.retentionBeatTargets?.length >= 1);
  });

  it("critic payload includes vlog retention context when vlog retention applies", async () => {
    const base = loadFixture("recipe-draft.json");
    const recipe = {
      ...base,
      version: "2.2",
      batchContext: {
        ...base.batchContext,
        requiredFormats: ["16:9", "9:16"],
      },
      vlogRetentionProfile: { enabled: true },
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const criticResponse = loadFixture("critic-response.json");
    const client = createMockOpenAIClient([criticResponse], { captureRequests: true });

    await runCritic(client, {
      recipe,
      abstraction,
      timelineIndex,
      iteration: 1,
      requiredFormats: ["16:9", "9:16"],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.ok(payload.vlogRetentionProfile);
    assert.equal(payload.vlogRetentionProfile.enabled, true);
    assert.ok(payload.retentionBeatTargetsMain?.length >= 1);
  });
});
