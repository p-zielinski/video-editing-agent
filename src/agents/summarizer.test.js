import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAbstractionBundle,
  groupScenesForL1Summarization,
  isSilentSceneInput,
} from "./summarizer.js";
import { sceneSummaryInput } from "../lib/abstraction-chunking.js";
import { AbstractL1Schema } from "../schemas/edit-recipe.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";

function makeSilentScene(index) {
  return {
    sceneId: `clip01_scene${String(index).padStart(3, "0")}`,
    clipId: "clip01",
    startSec: index * 10,
    endSec: (index + 1) * 10,
    durationSec: 10,
    aspectRatio: "16:9",
    hasSpeech: false,
  };
}

function makeBatchL1Response(sceneIds) {
  return {
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      summary: `Cicha scena ${sceneId}.`,
      mood: "neutralny",
      keyMoments: [],
      brollPotential: 0.85,
      topics: [],
      visualQuality: "medium",
      stability: "unknown",
    })),
  };
}

describe("summarizer agent", () => {
  it("builds L1/L2/L3 bundle with mocked OpenAI", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    const client = createMockOpenAIClient([l1, l1, l2, l3]);
    const bundle = await buildAbstractionBundle(client, timelineIndex, {
      userContext: "vlog dzień 66",
    });

    assert.equal(bundle.version, "1.0");
    assert.equal(bundle.batchId, "testbatch");
    assert.equal(bundle.L1.length, 2);
    assert.equal(bundle.L2.length, 1);
    assert.equal(bundle.L3.sessionSummary, l3.sessionSummary);
    assert.equal(bundle.L1[0].brollPotential, 0.15);
    assert.deepEqual(bundle.L1[0].topics, ["twarz", "pokój"]);
    assert.equal(bundle.L1[0].visualQuality, "high");
    assert.equal(bundle.L1[0].stability, "stable");
  });

  it("batches consecutive silent scenes into fewer GPT calls", async () => {
    const silentScenes = Array.from({ length: 10 }, (_, i) => makeSilentScene(i + 1));
    const timelineIndex = {
      version: "1.0",
      batchId: "silent-batch",
      clips: [{ clipId: "clip01", durationSec: 100 }],
      scenes: silentScenes,
      words: [],
      visionCaptions: [],
      stats: { totalDurationSec: 100, totalScenes: 10 },
    };

    const batch1Ids = silentScenes.slice(0, 8).map((s) => s.sceneId);
    const batch2Ids = silentScenes.slice(8).map((s) => s.sceneId);
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    let apiCallCount = 0;
    const responses = [
      makeBatchL1Response(batch1Ids),
      makeBatchL1Response(batch2Ids),
      l2,
      l3,
    ];
    const client = createMockOpenAIClient(responses, { captureRequests: true });
    const originalCreate = client.chat.completions.create;
    client.chat.completions.create = async (...args) => {
      apiCallCount += 1;
      return originalCreate(...args);
    };

    const bundle = await buildAbstractionBundle(client, timelineIndex);

    assert.equal(bundle.L1.length, 10);
    assert.ok(apiCallCount < 10, `expected fewer than 10 API calls, got ${apiCallCount}`);
    assert.equal(apiCallCount, 4);

    const requests = client.getCapturedRequests();
    const l1Tasks = requests
      .map((r) => JSON.parse(r.messages[1].content).task)
      .filter((task) => task.startsWith("L1_"));
    assert.deepEqual(l1Tasks, ["L1_batch_summary", "L1_batch_summary"]);
  });

  it("groups silent scenes with max 8 per batch", () => {
    const scenes = Array.from({ length: 10 }, (_, i) => makeSilentScene(i + 1));
    const groups = groupScenesForL1Summarization(scenes, [], []);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].type, "batch");
    assert.equal(groups[0].inputs.length, 8);
    assert.equal(groups[1].type, "batch");
    assert.equal(groups[1].inputs.length, 2);
  });

  it("keeps speech or visual scenes as individual L1 calls", () => {
    const scenes = [
      { ...makeSilentScene(1), startSec: 0, endSec: 10 },
      { ...makeSilentScene(2), startSec: 10, endSec: 20 },
      { ...makeSilentScene(3), hasSpeech: true, startSec: 20, endSec: 30 },
      { ...makeSilentScene(4), startSec: 30, endSec: 40 },
    ];
    const words = [
      { wordId: "w1", word: "cześć", start: 21, end: 21.5, isFiller: false },
    ];
    const visionCaptions = [];

    const groups = groupScenesForL1Summarization(scenes, words, visionCaptions);

    assert.equal(groups.length, 3);
    assert.equal(groups[0].type, "batch");
    assert.equal(groups[0].inputs.length, 2);
    assert.equal(groups[1].type, "single");
    assert.equal(groups[1].input.sceneId, scenes[2].sceneId);
    assert.equal(groups[2].type, "batch");
    assert.equal(groups[2].inputs.length, 1);
  });

  it("detects silent scene inputs without speech or visual captions", () => {
    const scene = makeSilentScene(1);
    const input = sceneSummaryInput(scene, [], []);
    assert.equal(isSilentSceneInput(input), true);

    const withSpeech = sceneSummaryInput(
      { ...scene, hasSpeech: true },
      [{ wordId: "w1", word: "hej", start: 11, end: 11.5, isFiller: false }],
      [],
    );
    assert.equal(isSilentSceneInput(withSpeech), false);

    const withVisual = sceneSummaryInput(
      scene,
      [],
      [{ sceneId: scene.sceneId, caption: "ulica", timestampSec: 1 }],
    );
    assert.equal(isSilentSceneInput(withVisual), false);
  });

  it("passes clipRegistry to L3 session summary in buildAbstractionBundle", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");
    const clipRegistry = [
      {
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      },
    ];

    const client = createMockOpenAIClient([l1, l1, l2, l3], { captureRequests: true });
    await buildAbstractionBundle(client, timelineIndex, { clipRegistry });

    const requests = client.getCapturedRequests();
    const l3Request = requests
      .map((r) => JSON.parse(r.messages[1].content))
      .find((payload) => payload.task === "L3_session_summary");

    assert.ok(l3Request, "expected L3_session_summary request");
    assert.deepEqual(l3Request.clipHints, [
      {
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      },
    ]);
  });

  it("AbstractL1Schema accepts isNarrationSource: true from mocked L1 response", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1Base = loadFixture("summarizer-l1.json");
    const l1WithNarration = { ...l1Base, isNarrationSource: true };
    const l2 = loadFixture("summarizer-l2.json");
    const l3 = loadFixture("summarizer-l3.json");

    const client = createMockOpenAIClient([l1WithNarration, l1WithNarration, l2, l3]);
    const bundle = await buildAbstractionBundle(client, timelineIndex);

    assert.equal(bundle.L1[0].isNarrationSource, true);
    assert.deepEqual(AbstractL1Schema.parse(l1WithNarration).isNarrationSource, true);
  });

  it("AbstractionBundle accepts hasSeparateNarration: true in L3", async () => {
    const timelineIndex = loadFixture("timeline-index.json");
    const l1 = loadFixture("summarizer-l1.json");
    const l2 = loadFixture("summarizer-l2.json");
    const l3WithVO = {
      ...loadFixture("summarizer-l3.json"),
      hasSeparateNarration: true,
    };

    const client = createMockOpenAIClient([l1, l1, l2, l3WithVO]);
    const bundle = await buildAbstractionBundle(client, timelineIndex, {
      clipRegistry: [{
        clipId: "clip03",
        clipRole: "narration_track",
        mediaType: "audio_only",
        hasSpeech: true,
      }],
    });

    assert.equal(bundle.L3.hasSeparateNarration, true);
  });
});
