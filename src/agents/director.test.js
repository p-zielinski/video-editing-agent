import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectorBrief,
  buildTranscriptExcerpts,
  runDirector,
  directorDrillDown,
  filterL1ForScenes,
  selectScenesForDirectorMap,
} from "./director.js";
import { buildAudioIndexSummary } from "../editorial/audio-index-summary.js";
import { createMockOpenAIClient, loadFixture } from "./test-helpers.js";

describe("director agent v2", () => {
  const abstraction = loadFixture("abstraction.json");
  const timelineIndex = loadFixture("timeline-index.json");
  const recipeDraft = loadFixture("recipe-draft.json");

  const clipRegistry = [
    {
      clipId: "clip01",
      fileName: "clip01.mp4",
      durationSec: 120,
      sortIndex: 0,
      clipRole: "aroll_primary",
      roleConfidence: 0.75,
      roleSource: "clip_profile",
      hasSpeech: true,
      speechWordCount: 3,
    },
  ];

  const topicIndex = {
    version: "1.0",
    batchId: "testbatch",
    topics: [],
  };

  const spatialIndex = {
    version: "1.0",
    batchId: "testbatch",
    scenes: [
      {
        sceneId: "clip01_scene001",
        anchors: [
          {
            type: "subject",
            bbox: [0.2, 0.25, 0.4, 0.5],
            timestampSec: 5,
            label: "person",
            confidence: 0.8,
          },
        ],
      },
    ],
  };

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

  it("includes transcriptExcerpts for A-roll scenes with word-level data", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.transcriptExcerpts.length, 2);
    const scene1 = brief.transcriptExcerpts.find((e) => e.sceneId === "clip01_scene001");
    assert.equal(scene1.clipId, "clip01");
    assert.equal(scene1.words.length, 2);
    assert.deepEqual(scene1.words[0], {
      wordId: "clip01_w001",
      word: "cześć",
      start: 1,
      end: 1.4,
      isFiller: false,
    });
    assert.equal(scene1.words[1].isFiller, true);

    const scene2 = brief.transcriptExcerpts.find((e) => e.sceneId === "clip01_scene002");
    assert.equal(scene2.words.length, 1);
    assert.equal(scene2.words[0].word, "świat");
  });

  it("caps transcriptExcerpts at 80 words per scene", () => {
    const manyWords = Array.from({ length: 100 }, (_, i) => ({
      wordId: `clip01_w${String(i + 1).padStart(3, "0")}`,
      word: `word${i}`,
      start: i * 0.1,
      end: i * 0.1 + 0.05,
      isFiller: false,
    }));
    const index = {
      ...timelineIndex,
      scenes: [
        {
          ...timelineIndex.scenes[0],
          endSec: 10,
        },
      ],
      words: manyWords,
    };

    const excerpts = buildTranscriptExcerpts(index);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].words.length, 80);
    assert.equal(excerpts[0].words[0].wordId, "clip01_w001");
    assert.equal(excerpts[0].words[79].wordId, "clip01_w080");
  });

  it("omits non-speech scenes from transcriptExcerpts", () => {
    const index = {
      ...timelineIndex,
      scenes: [
        { ...timelineIndex.scenes[0], hasSpeech: false },
        timelineIndex.scenes[1],
      ],
    };

    const excerpts = buildTranscriptExcerpts(index);
    assert.equal(excerpts.length, 1);
    assert.equal(excerpts[0].sceneId, "clip01_scene002");
  });

  it("includes beatTimestamps in audioIndex summary", () => {
    const summary = buildAudioIndexSummary(audioIndex);
    assert.equal(summary.clips[0].beatTimestamps.length, 3);
    assert.deepEqual(summary.clips[0].beatTimestamps, [0.5, 1.0, 1.5]);

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex,
      requiredFormats: ["16:9"],
    });

    assert.deepEqual(brief.audioIndex.clips[0].beatTimestamps, [0.5, 1.0, 1.5]);
    assert.ok(Array.isArray(brief.sfxPlanDefaults));
    assert.equal(brief.sfxPlanDefaults.length, 0);
  });

  it("includes spatialIndex summary when provided", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.spatialIndex.scenes.length, 1);
    assert.equal(brief.spatialIndex.scenes[0].sceneId, "clip01_scene001");
    assert.equal(brief.spatialIndex.scenes[0].primaryAnchor.type, "subject");
  });

  it("includes spatialRefExamples from spatial index", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.spatialRefExamples.length, 1);
    assert.equal(brief.spatialRefExamples[0].sceneId, "clip01_scene001");
    assert.equal(brief.spatialRefExamples[0].anchorType, "subject");
    assert.ok(Array.isArray(brief.spatialRefExamples[0].bbox));
  });

  it("builds v2 brief with clipRegistry, topicIndex, inputMode, brollCandidates", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9", "9:16"],
      batchContext: { brollMatchThreshold: 0.55 },
    });

    assert.equal(brief.version, "2.2");
    assert.equal(brief.inputMode, "single_clip");
    assert.equal(brief.clipRegistry.length, 1);
    assert.equal(brief.topicIndex.topics.length, 0);
    assert.equal(brief.fillerStats.totalFillers, 1);
    assert.equal(brief.sceneMap.length, 2);
    assert.equal(brief.sceneMap[0].mood, "luźny");
    assert.deepEqual(brief.sceneMap[0].keyMoments, ["cześć"]);
    assert.equal(brief.sceneMap[0].summary, "Powitanie widzów w pokoju.");
    assert.equal(brief.sceneMap[1].mood, "energetyczny");
    assert.deepEqual(brief.sceneMap[1].keyMoments, ["świat"]);
    assert.equal(brief.constraints.brollMatchThreshold, 0.55);
    assert.ok(brief.techniqueCatalog);
    assert.ok(brief.creativityProfile);
    assert.ok(brief.creativityBudget);
    assert.ok(Array.isArray(brief.brollCandidates));
    assert.equal(brief.sceneSummariesL1, undefined);
    assert.ok(brief.l1SceneSummaries);
    assert.equal(brief.l1SceneSummaries.length, 2);
    assert.equal(brief.shortsRetentionProfile, undefined);
    assert.equal(brief.retentionGrammarSummary, null);
    assert.equal(brief.retentionBeatTargets, undefined);
    assert.equal(brief.constraints.retentionRules, undefined);
  });

  it("injects retention for short-only requiredFormats", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["9:16"],
      batchContext: {},
    });

    assert.ok(brief.shortsRetentionProfile);
    assert.ok(brief.retentionGrammarSummary);
    assert.ok(brief.retentionBeatTargets?.length >= 1);
    assert.equal(brief.constraints.retentionRules, "V22-01 … V22-07");
  });

  it("omits retention injection when 9:16 not required", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      batchContext: {},
    });

    assert.equal(brief.shortsRetentionProfile, undefined);
    assert.equal(brief.retentionGrammarSummary, null);
    assert.equal(brief.retentionBeatTargets, undefined);
    assert.equal(brief.constraints.retentionRules, undefined);
  });

  it("shorts: energy high keeps shorts_energy pack while enabling retention", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      userContext: "shorts: energy high",
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(brief.creativityProfile.techniquePack, "shorts_energy");
    assert.ok(brief.shortsRetentionProfile);
  });

  it("detects multi_clip_day for multiple clips", () => {
    const multiIndex = {
      ...timelineIndex,
      clips: [
        { clipId: "clip01", durationSec: 120 },
        { clipId: "clip02", durationSec: 60 },
      ],
    };
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex: multiIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9", "9:16"],
    });
    assert.equal(brief.inputMode, "multi_clip_day");
  });

  it("includes l1SceneSummaries with full L1 fields for small batches", () => {
    const richAbstraction = {
      ...abstraction,
      L1: [
        {
          sceneId: "clip01_scene001",
          summary: "Powitanie widzów w pokoju.",
          topics: ["intro"],
          mood: "luźny",
          keyMoments: ["cześć"],
          brollPotential: 0.2,
          visualQuality: "high",
          stability: "stable",
        },
        {
          sceneId: "clip01_scene002",
          summary: "Kontynuacja vloga na zewnątrz.",
          topics: ["spacer"],
          mood: "energetyczny",
          keyMoments: ["spacer"],
          brollPotential: 0.4,
          visualQuality: "medium",
          stability: "handheld",
        },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction: richAbstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.l1SceneSummaries.length, 2);
    assert.deepEqual(brief.l1SceneSummaries[0], {
      sceneId: "clip01_scene001",
      summary: "Powitanie widzów w pokoju.",
      mood: "luźny",
      keyMoments: ["cześć"],
      brollPotential: 0.2,
      topics: ["intro"],
      visualQuality: "high",
      stability: "stable",
    });
    assert.equal(brief.l1SceneSummaries[1].sceneId, "clip01_scene002");
    assert.equal(brief.l1SceneSummaries[1].mood, "energetyczny");
    assert.deepEqual(brief.l1SceneSummaries[1].keyMoments, ["spacer"]);
    assert.equal(brief.l1SceneSummaries[1].stability, "handheld");
  });

  it("truncates long L1 summaries in sceneMap and l1SceneSummaries", () => {
    const longSummary = "A".repeat(150);
    const richAbstraction = {
      ...abstraction,
      L1: [
        {
          sceneId: "clip01_scene001",
          summary: longSummary,
          mood: "spokojny",
          keyMoments: ["moment"],
        },
        abstraction.L1[1],
      ],
    };

    const brief = buildDirectorBrief({
      abstraction: richAbstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.sceneMap[0].summary.length, 120);
    assert.ok(brief.sceneMap[0].summary.endsWith("…"));
    assert.equal(brief.l1SceneSummaries[0].summary.length, 120);
  });

  it("omits l1SceneSummaries when batch has more than 5 scenes", () => {
    const manyScenes = Array.from({ length: 6 }, (_, i) => ({
      sceneId: `clip01_scene00${i + 1}`,
      clipId: "clip01",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
      aspectRatio: "16:9",
      hasSpeech: true,
    }));
    const manyIndex = {
      ...timelineIndex,
      scenes: manyScenes,
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex: manyIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.l1SceneSummaries, undefined);
  });

  it("uses compact sceneMap for batches with more than 20 scenes", () => {
    const manyScenes = Array.from({ length: 25 }, (_, i) => ({
      sceneId: `clip${i < 2 || i === 24 ? "01" : "02"}_scene${String(i + 1).padStart(3, "0")}`,
      clipId: i < 2 || i === 24 ? "clip01" : "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
      aspectRatio: "16:9",
      hasSpeech: i === 0 || i === 24,
    }));

    const manyL1 = manyScenes.map((scene, i) => ({
      sceneId: scene.sceneId,
      summary: `Scene ${i + 1}`,
      brollPotential: i === 5 ? 0.7 : 0.1,
      visualQuality: i < 3 ? "high" : "low",
    }));

    const largeTopicIndex = {
      version: "1.0",
      batchId: "testbatch",
      topics: [
        {
          topicId: "t1",
          label: "topic",
          wordIds: [],
          timeRange: { clipId: "clip02", startSec: 0, endSec: 250 },
          matchingScenes: [{ sceneId: "clip02_scene012", score: 0.8 }],
        },
      ],
    };

    const mixedClipRegistry = [
      {
        clipId: "clip01",
        fileName: "clip01.mp4",
        durationSec: 30,
        sortIndex: 0,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 10,
      },
      {
        clipId: "clip02",
        fileName: "clip02.mp4",
        durationSec: 230,
        sortIndex: 1,
        clipRole: "broll_pool",
        hasSpeech: false,
        speechWordCount: 0,
      },
    ];

    const largeIndex = {
      ...timelineIndex,
      clips: [
        { clipId: "clip01", durationSec: 30 },
        { clipId: "clip02", durationSec: 230 },
      ],
      scenes: manyScenes,
    };

    const largeAbstraction = {
      ...abstraction,
      L1: manyL1,
    };

    const brief = buildDirectorBrief({
      abstraction: largeAbstraction,
      timelineIndex: largeIndex,
      clipRegistry: mixedClipRegistry,
      topicIndex: largeTopicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.sceneMapPolicy, "compact_large_batch");
    assert.ok(brief.sceneMapOmittedCount > 0);
    assert.ok(brief.sceneMap.length < 25);
    assert.ok(brief.sceneMap.length > 0);
    assert.ok(brief.sceneRanks.length <= 10);
    assert.ok(brief.brollCandidates.length > brief.sceneMap.length);

    const sceneMapIds = new Set(brief.sceneMap.map((s) => s.sceneId));
    assert.ok(sceneMapIds.has("clip01_scene001"));
    assert.ok(sceneMapIds.has("clip01_scene025"));
    assert.ok(sceneMapIds.has("clip02_scene006"));
    assert.ok(sceneMapIds.has("clip02_scene012"));

    const brollIds = new Set(brief.brollCandidates.map((s) => s.sceneId));
    assert.ok(brief.brollCandidates.some((c) => !sceneMapIds.has(c.sceneId)));
    assert.ok(brollIds.has("clip02_scene006"));
  });

  it("selectScenesForDirectorMap applies inclusion criteria", () => {
    const scenes = [
      { sceneId: "s_speech", clipId: "clip01", hasSpeech: true },
      { sceneId: "s_broll", clipId: "clip02", hasSpeech: false },
      { sceneId: "s_ranked", clipId: "clip03", hasSpeech: false },
      { sceneId: "s_topic", clipId: "clip04", hasSpeech: false },
      { sceneId: "s_aroll", clipId: "clip05", hasSpeech: false },
      { sceneId: "s_skip", clipId: "clip06", hasSpeech: false },
    ];
    const index = { scenes };
    const abs = {
      L1: [
        { sceneId: "s_speech", brollPotential: 0.1 },
        { sceneId: "s_broll", brollPotential: 0.6 },
        { sceneId: "s_ranked", brollPotential: 0.1 },
        { sceneId: "s_topic", brollPotential: 0.1 },
        { sceneId: "s_aroll", brollPotential: 0.1 },
        { sceneId: "s_skip", brollPotential: 0.1 },
      ],
    };
    const topics = {
      topics: [
        {
          topicId: "t1",
          matchingScenes: [{ sceneId: "s_topic", score: 0.7 }],
        },
      ],
    };
    const registry = [
      { clipId: "clip05", clipRole: "aroll_primary" },
      { clipId: "clip06", clipRole: "broll_pool" },
    ];
    const ranks = [{ sceneId: "s_ranked", rank: 0.9 }];

    const selected = selectScenesForDirectorMap(index, abs, topics, registry, ranks);
    const ids = selected.map((s) => s.sceneId).sort();

    assert.deepEqual(ids, [
      "s_aroll",
      "s_broll",
      "s_ranked",
      "s_speech",
      "s_topic",
    ]);
  });

  it("includes sceneRanks top highlights in brief", () => {
    const richAbstraction = {
      ...abstraction,
      L1: [
        {
          sceneId: "clip01_scene001",
          brollPotential: 0.2,
          visualQuality: "medium",
        },
        {
          sceneId: "clip01_scene002",
          brollPotential: 0.85,
          visualQuality: "high",
        },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction: richAbstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(Array.isArray(brief.sceneRanks));
    assert.ok(brief.sceneRanks.length <= 10);
    assert.equal(brief.sceneRanks[0].sceneId, "clip01_scene002");
    assert.ok(brief.sceneRanks[0].rank >= brief.sceneRanks[1].rank);
  });

  it("includes L1 only when explicitly requested", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9"],
      includeL1: true,
    });

    assert.equal(brief.sceneSummariesL1.length, 2);
  });

  it("filters L1 summaries for selected sceneIds", () => {
    const filtered = filterL1ForScenes(abstraction, ["clip01_scene001"]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].sceneId, "clip01_scene001");
  });

  it("runs two-pass director flow with mocked OpenAI", async () => {
    const refinedRecipe = loadFixture("fixer-response.json");
    const client = createMockOpenAIClient([recipeDraft, refinedRecipe], { captureRequests: true });

    const draft = await runDirector(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9", "9:16"],
    });

    assert.equal(draft.version, "2.0");
    assert.equal(draft.outputs.length, 2);
    assert.equal(draft.outputs[0].timeline[0].videoRef.sceneId, "clip01_scene001");
    assert.equal(draft.outputs[0].timeline[0].segmentRole, "aroll");

    const sceneIds = draft.outputs.flatMap((o) =>
      o.timeline.flatMap((s) => [s.videoRef.sceneId, s.audioRef.sceneId]),
    );
    const refined = await directorDrillDown(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex,
      audioIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9", "9:16"],
      recipe: draft,
      sceneIds,
    });

    assert.equal(refined.outputs[0].title, "Vlog skrót (poprawiony)");
    assert.equal(refined.outputs[0].timeline[0].cuts.length, 1);

    const drillDownRequest = client.getCapturedRequests()[1];
    const drillDownPayload = JSON.parse(drillDownRequest.messages[1].content);
    assert.equal(drillDownPayload.task, "drill_down_refine");
    assert.equal(drillDownPayload.sceneSummariesL1.length, 2);
    assert.equal(drillDownPayload.topicIndex, undefined);
    assert.equal(drillDownPayload.drillDownSceneDetails.length, 2);
    assert.ok(drillDownPayload.techniqueCatalog);
    assert.ok(drillDownPayload.creativityProfile);
    assert.ok(drillDownPayload.creativityBudget);
    assert.equal(drillDownPayload.spatialIndex.scenes.length, 1);
    assert.equal(drillDownPayload.spatialIndex.scenes[0].sceneId, "clip01_scene001");
    assert.ok(Array.isArray(drillDownPayload.spatialRefExamples));
    assert.equal(drillDownPayload.transcriptExcerpts.length, 2);
    assert.deepEqual(drillDownPayload.audioIndex.clips[0].beatTimestamps, [0.5, 1.0, 1.5]);
  });
});
