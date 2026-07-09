import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runFixer,
  shouldInvokeFixer,
  resolveFixerPromptVersion,
  recipeHasCreativeLayer,
  FIXABLE_NAR_WARNING_CODES,
} from "./fixer.js";
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
  it("resolveFixerPromptVersion uses v2 for all 2.x recipe versions", () => {
    assert.equal(resolveFixerPromptVersion({ version: "2.0" }), "v2");
    assert.equal(resolveFixerPromptVersion({ version: "2.3" }), "v2");
    assert.equal(resolveFixerPromptVersion({ version: "2.4" }), "v2");
    assert.equal(resolveFixerPromptVersion({ version: "2.10" }), "v2");
    assert.equal(resolveFixerPromptVersion({ version: "1.0" }), "v1");
    assert.equal(resolveFixerPromptVersion({ version: "3.0" }), "v1");
  });

  it("recipeHasCreativeLayer is true for version 2.4", () => {
    assert.equal(recipeHasCreativeLayer({ version: "2.4" }), true);
    assert.equal(recipeHasCreativeLayer({ version: "2.0" }), false);
    assert.equal(recipeHasCreativeLayer({ version: "2.0", creativeMoments: [{}] }), true);
  });

  it("includes spatialIndex in repair payload when version is 2.4", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.4",
      creativeMoments: [],
    };
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = loadFixture("timeline-index.json");
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        anchors: [{ anchorId: "face_center", x: 0.5, y: 0.4 }],
      }],
    };
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
      spatialIndex,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.ok(payload.spatialIndex);
    assert.equal(payload.spatialIndex.scenes[0].sceneId, "clip01_scene001");
  });

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

  it("shouldInvokeFixer returns true for V25-BROLL-06 warning", () => {
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V25-BROLL-06", message: "broll sync drift" },
    ]), true);
  });

  it("shouldInvokeFixer returns true for NAR-BREATH-BEAT warning", () => {
    assert.ok(FIXABLE_NAR_WARNING_CODES.has("NAR-BREATH-BEAT"));
    assert.ok(FIXABLE_NAR_WARNING_CODES.has("NAR-CLOSURE-SPAM"));
    assert.ok(FIXABLE_NAR_WARNING_CODES.has("NAR-CALLBACK-UNDELIVERED"));
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "NAR-BREATH-BEAT", message: "beat in breath segment" },
    ]), true);
  });

  it("shouldInvokeFixer returns true for NAR-BEAT-SPAM warning", () => {
    assert.ok(FIXABLE_NAR_WARNING_CODES.has("NAR-BEAT-SPAM"));
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "NAR-BEAT-SPAM", message: "too many beats in slow segment" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "NAR-OTHER", message: "unlisted narrative code" },
    ]), false);
  });

  it("shouldInvokeFixer returns true for NAR-DRAMATIC-PAUSE-CUT error", () => {
    assert.equal(shouldInvokeFixer([
      { severity: "error", code: "NAR-DRAMATIC-PAUSE-CUT", message: "dead_air cut in preserve segment" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "NAR-DRAMATIC-PAUSE-CUT", message: "dead_air cut in dramatic_pause" },
    ]), true);
  });

  it("runFixer includes narrativeIssues and narrative context in payload", async () => {
    const recipe = {
      ...loadFixture("recipe-draft.json"),
      version: "2.2",
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{ l2SegmentId: "seg001", rhythm: "slow", silencePolicy: "preserve" }],
      },
      creativeMoments: [],
    };
    const abstraction = {
      ...loadFixture("abstraction.json"),
      L3: {
        ...loadFixture("abstraction.json").L3,
        openLoops: [{
          kind: "cold_open",
          payoffSceneId: "clip01_scene002",
          tease: "co się stało?",
        }],
      },
    };
    const timelineIndex = loadFixture("timeline-index.json");
    const fixerResponse = loadFixture("fixer-response.json");
    const review = {
      version: "1.0",
      batchId: "testbatch",
      iteration: 1,
      approved: false,
      issues: [
        { severity: "warning", code: "NAR-BEAT-SPAM", message: "beat spam" },
        { severity: "warning", code: "V22-VLOG-01", message: "min beats" },
      ],
      summary: "fix narrative",
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
    assert.equal(payload.narrativeIssues.length, 1);
    assert.equal(payload.narrativeIssues[0].code, "NAR-BEAT-SPAM");
    assert.equal(payload.openLoops.length, 1);
    assert.equal(payload.narrativeProfile.mode, "internet_documentary");
    assert.equal(payload.issues.length, 2);
  });

  it("shouldInvokeFixer returns true for V24-05 and V25 chronology/broll warnings", () => {
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V24-05", message: "main too long" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "error", code: "V25-CHR-03", message: "cold open rewind" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V25-BROLL-04", message: "broll pool" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V25-BROLL-05", message: "chronological broll" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V22-OTHER", message: "unfixable" },
    ]), false);
  });

  it("shouldInvokeFixer returns true for V26 coverage warnings", () => {
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V26-FILLER-01", message: "filler" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V26-DEADAIR-01", message: "dead air" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V26-CTA-01", message: "cta" },
    ]), true);
    assert.equal(shouldInvokeFixer([
      { severity: "warning", code: "V26-CHAPTER-01", message: "chapter" },
    ]), true);
  });

  it("runFixer includes brollSyncHints in payload when provided", async () => {
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
      issues: [{ severity: "warning", code: "V25-BROLL-06", message: "drift" }],
      summary: "fix broll sync",
    };

    const client = createMockOpenAIClient([fixerResponse], { captureRequests: true });
    await runFixer(client, {
      recipe,
      review,
      abstraction,
      timelineIndex,
      audioIndex,
      brollSyncHints: [{
        sceneId: "clip02_scene001",
        suggestedVideoInSec: 5,
        confidence: 0.9,
      }],
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.brollSyncHints.length, 1);
    assert.equal(payload.brollSyncHints[0].sceneId, "clip02_scene001");
  });
});
