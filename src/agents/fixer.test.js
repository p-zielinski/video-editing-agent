import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFixer, shouldInvokeFixer } from "./fixer.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";

const audioIndex = {
  version: "1.0",
  batchId: "testbatch",
  clips: [
    {
      clipId: "clip01",
      voiceLufs: -17.2,
      beatCount: 3,
      beatTimes: [0.5, 1.0, 1.5],
      silenceGapCount: 1,
      totalSilenceSec: 1.2,
      recommendedTrackId: "upbeat_vlog_01",
      estimatedBpm: 120,
    },
  ],
  batchSummary: {
    avgVoiceLufs: -17.2,
    totalSilenceSec: 1.2,
    dominantMood: "vlog",
    estimatedBpm: 120,
    clipCount: 1,
  },
  musicLibrary: { trackCount: 0, tracks: [] },
};

describe("fixer agent", () => {
  it("includes transcriptExcerpts and audioIndex in repair payload", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const fixerResponse = loadFixture("fixer-response.json");
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "CUT_WORDID_WRONG_CLIP", message: "bad wordId" }],
      summary: "needs fix",
    };

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(client, {
      recipe,
      review,
      abstraction,
      timelineIndex,
      audioIndex,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.transcriptExcerpts.length, 2);
    assert.equal(payload.transcriptExcerpts[0].sceneId, "clip01_scene001");
    assert.equal(payload.transcriptExcerpts[0].words[0].wordId, "clip01_w001");
    assert.equal(payload.audioIndex.clips[0].beatTimestamps.length, 3);
    assert.equal(payload.wordIdHint, undefined);
  });

  it("falls back to wordIdHint when timelineIndex is missing", async () => {
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
    const wordIndexes = [{
      clipId: "clip01",
      words: loadFixture("timeline-index.json").words,
    }];
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "V21-09", message: "bad anchorWordId" }],
      summary: "needs fix",
    };

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(client, {
      recipe,
      review,
      abstraction,
      wordIndexes,
      audioIndex,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.deepEqual(payload.transcriptExcerpts, []);
    assert.equal(payload.wordIdHint.wordCount, 3);
    assert.ok(payload.wordIdHint.wordIdSample.includes("clip01_w001"));
    assert.equal(payload.audioIndex.clips[0].clipId, "clip01");
    assert.ok(payload.techniqueCatalog);
    assert.equal(payload.techniqueCatalogSummary, undefined);
  });

  it("includes deadAirHints in payload when audioIndex has silence gaps", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const fixerResponse = loadFixture("fixer-response.json");
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "TEST", message: "test issue" }],
      summary: "needs fix",
    };
    const indexWithGaps = {
      ...audioIndex,
      clips: [{
        ...audioIndex.clips[0],
        silenceGaps: [{ startSec: 1, endSec: 64, durationSec: 63 }],
      }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 1, endSec: 64, durationSec: 63 }],
    }];

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(client, {
      recipe,
      review,
      abstraction,
      timelineIndex,
      audioIndex: indexWithGaps,
      perClipAnalysis,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    const hints = payload.audioIndex.clips[0].deadAirHints;
    assert.ok(hints?.length >= 1);
    assert.ok(hints.some((hint) => hint.source === "transcript" || hint.source === "both"));
  });

  it("uses techniqueCatalog key not techniqueCatalogSummary", async () => {
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
    const fixerResponse = loadFixture("fixer-response.json");
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "TEST", message: "test issue" }],
      summary: "needs fix",
    };

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(client, {
      recipe,
      review,
      abstraction,
      timelineIndex,
      audioIndex,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.ok(payload.techniqueCatalog);
    assert.ok(Array.isArray(payload.techniqueCatalog.techniques));
    assert.equal(payload.techniqueCatalogSummary, undefined);
  });

  it("always includes transcriptExcerpts array in repair payload", async () => {
    const abstraction = loadFixture("abstraction.json");
    const fixerResponse = loadFixture("fixer-response.json");
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [{ severity: "error", code: "TEST", message: "test issue" }],
      summary: "needs fix",
    };
    const recipeWithTimeline = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };

    const clientWithTimeline = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(clientWithTimeline, {
      recipe: recipeWithTimeline,
      review,
      abstraction,
      timelineIndex: loadFixture("timeline-index.json"),
      audioIndex,
    });

    const payloadWithTimeline = JSON.parse(
      clientWithTimeline.getCapturedRequests()[0].messages[1].content,
    );
    assert.ok(Array.isArray(payloadWithTimeline.transcriptExcerpts));
    assert.ok(payloadWithTimeline.transcriptExcerpts.length > 0);

    const recipeWithoutTimeline = {
      ...loadFixture("recipe-draft.json"),
      version: "2.1",
      creativeMoments: [],
    };
    const clientWithoutTimeline = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(clientWithoutTimeline, {
      recipe: recipeWithoutTimeline,
      review,
      abstraction,
      audioIndex,
    });

    const payloadWithoutTimeline = JSON.parse(
      clientWithoutTimeline.getCapturedRequests()[0].messages[1].content,
    );
    assert.ok(Array.isArray(payloadWithoutTimeline.transcriptExcerpts));
    assert.equal(payloadWithoutTimeline.transcriptExcerpts.length, 0);
  });

  it("shouldInvokeFixer returns true for V22-VLOG-03/04 warnings without errors", () => {
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V22-VLOG-03", message: "aggressive beat" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V22-VLOG-04", message: "monotony" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V22-VLOG-05", message: "target drift" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "error", code: "V22-VLOG-01", message: "min beats" },
    ]), true);
    assert.equal(shouldInvokeFixer([]), false);
  });
});
