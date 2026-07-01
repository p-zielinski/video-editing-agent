import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectorBrief,
  buildTranscriptExcerpts,
  runDirector,
  directorDrillDown,
  filterL1ForScenes,
  selectScenesForDirectorMap,
  expandCompactSceneMapSelection,
  enrichClipRegistryForBrief,
  buildAudioEventAnchors,
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

  it("includes aspectMix, clipAspectById, and sfxCatalogSummary in brief", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(brief.aspectMix);
    assert.ok(brief.clipAspectById);
    assert.equal(brief.clipAspectById.clip01, "16:9");
    assert.ok(Array.isArray(brief.sfxCatalogSummary));
    assert.ok(brief.sfxCatalogSummary.length > 0);
    assert.ok(brief.sfxCatalogSummary[0].sfxId);
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

  it("includes deadAirMontageHints when fused dead air has source both", () => {
    const wordIndexes = [{
      clipId: "clip01",
      durationSec: 73.5,
      words: [
        { wordId: "clip01_w001", word: "cześć", start: 0, end: 1 },
        { wordId: "clip01_w002", word: "świat", start: 72.5, end: 73.5 },
      ],
    }];
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 72, endSec: 73.2, durationSec: 1.2 }],
    }];

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex,
      perClipAnalysis,
      wordIndexes,
      requiredFormats: ["16:9"],
    });

    assert.ok(Array.isArray(brief.deadAirMontageHints));
    assert.ok(brief.deadAirMontageHints.length >= 1);
    assert.equal(brief.deadAirMontageHints[0].source, "both");
    assert.ok(brief.deadAirMontageHints[0].suggestion.includes("silence_beat"));
  });

  it("includes retentionBeatAnchors when vlog retention and audio peaks present", () => {
    const richAudioIndex = {
      ...audioIndex,
      clips: [{
        ...audioIndex.clips[0],
        energyCurve: [
          { startSec: 39, endSec: 41, rmsDb: -12 },
          { startSec: 46, endSec: 50, rmsDb: -10 },
        ],
      }],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex: richAudioIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(brief.vlogRetentionProfile);
    assert.ok(Array.isArray(brief.retentionBeatAnchors));
    assert.ok(brief.retentionBeatAnchors.length >= 1);
    assert.equal(brief.retentionBeatAnchors[0].retentionRole, "beat");
    assert.ok(brief.retentionBeatAnchors[0].suggestedTechniqueId);
  });

  it("includes chapterCardHints and narrativeOpenLoops in brief", () => {
    const longAbstraction = {
      ...abstraction,
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene001"],
          summary: "Rozmowa o restauracji.",
        },
        {
          segmentId: "seg002",
          startSec: 300,
          endSec: 600,
          sceneIds: ["clip01_scene002"],
          summary: "Podsumowanie wizyty.",
        },
      ],
      L3: {
        sessionSummary: "Vlog o restauracji i jedzeniu.",
        narrativeArc: "intro → restauracja → podsumowanie",
      },
    };

    const brief = buildDirectorBrief({
      abstraction: longAbstraction,
      timelineIndex: {
        ...timelineIndex,
        clips: [{ clipId: "clip01", durationSec: 720 }],
      },
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(Array.isArray(brief.chapterCardHints));
    assert.ok(brief.chapterCardHints.length >= 1);
    assert.equal(brief.chapterCardHints[0].style, "chapter_card");

    assert.ok(Array.isArray(brief.narrativeOpenLoops));
    assert.equal(brief.narrativeOpenLoops.length, 2);
    assert.equal(brief.narrativeOpenLoops[0].type, "cold_open");
    assert.equal(brief.narrativeOpenLoops[1].type, "payoff_tease");

    assert.ok(brief.coldOpenSegmentHint);
    assert.equal(brief.coldOpenSegmentHint.type, "cold_open");
    assert.equal(brief.coldOpenSegmentHint.suggestedSceneId, "clip01_scene002");
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
    assert.ok(brief.shortsRetentionProfile);
    assert.ok(brief.vlogRetentionProfile);
    assert.ok(brief.retentionGrammarSummary?.main);
    assert.ok(brief.retentionGrammarSummary?.short);
    assert.ok(brief.retentionBeatTargetsMain?.length >= 1);
    assert.ok(brief.retentionBeatTargetsShort?.length >= 1);
    assert.equal(
      brief.constraints.retentionRules,
      "V22-VLOG-01 … V22-VLOG-05 + V22-01 … V22-07",
    );
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

  it("injects vlog retention for 16:9-only requiredFormats", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      batchContext: {},
    });

    assert.ok(brief.vlogRetentionProfile);
    assert.equal(brief.vlogRetentionProfile.retentionBeatIntervalSec, 45);
    assert.ok(brief.retentionGrammarSummary);
    assert.ok(brief.retentionBeatTargets?.length >= 1);
    assert.ok(brief.retentionTechniqueRotation?.length >= 1);
    assert.equal(brief.retentionTechniqueRotation[0], "zoom_slow_push");
    assert.equal(brief.constraints.retentionRules, "V22-VLOG-01 … V22-VLOG-05");
    assert.equal(brief.shortsRetentionProfile, undefined);
  });

  it("dual format enables both vlog and shorts retention profiles", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
    });

    assert.ok(brief.shortsRetentionProfile);
    assert.ok(brief.vlogRetentionProfile);
    assert.ok(brief.retentionBeatTargetsMain?.length >= 1);
    assert.ok(brief.retentionBeatTargetsShort?.length >= 1);
    assert.ok(brief.retentionTechniqueRotationMain?.length >= 1);
    assert.ok(brief.retentionTechniqueRotationShort?.length >= 1);
    assert.ok(brief.retentionGrammarSummary?.main);
    assert.ok(brief.retentionGrammarSummary?.short);
    assert.equal(brief.retentionBeatTargets, undefined);
    assert.equal(
      brief.constraints.retentionRules,
      "V22-VLOG-01 … V22-VLOG-05 + V22-01 … V22-07",
    );
  });

  it("dual format exposes separate retentionBeatAnchorsMain and Short", () => {
    const richAudioIndex = {
      ...audioIndex,
      clips: [{
        ...audioIndex.clips[0],
        energyPeaks: [
          { startSec: 39, endSec: 41, rmsDb: -12 },
          { startSec: 46, endSec: 50, rmsDb: -10 },
        ],
      }],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex: richAudioIndex,
      requiredFormats: ["16:9", "9:16"],
      batchContext: {},
    });

    assert.ok(Array.isArray(brief.retentionBeatAnchorsMain));
    assert.ok(brief.retentionBeatAnchorsMain.length >= 1);
    assert.equal(brief.retentionBeatAnchorsMain[0].retentionRole, "beat");
    assert.equal(brief.retentionBeatAnchorsMain[0].suggestedTechniqueId, "zoom_slow_push");
    assert.ok(Array.isArray(brief.retentionBeatAnchorsShort));
    assert.ok(brief.retentionBeatAnchorsShort.length >= 1);
    assert.equal(brief.retentionBeatAnchorsShort[0].suggestedTechniqueId, "pattern_interrupt");
    assert.equal(brief.retentionBeatAnchors, undefined);
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
      isNarrationSource: false,
    });
    assert.equal(brief.l1SceneSummaries[1].sceneId, "clip01_scene002");
    assert.equal(brief.l1SceneSummaries[1].mood, "energetyczny");
    assert.deepEqual(brief.l1SceneSummaries[1].keyMoments, ["spacer"]);
    assert.equal(brief.l1SceneSummaries[1].stability, "handheld");
  });

  it("truncates long L1 summaries in sceneMap and l1SceneSummaries", () => {
    const longSummary = "A".repeat(550);
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

    assert.equal(brief.sceneMap[0].summary.length, 500);
    assert.ok(brief.sceneMap[0].summary.endsWith("…"));
    assert.equal(brief.l1SceneSummaries[0].summary.length, 500);
  });

  it("includes visionCaption in sceneMap from latest caption per scene", () => {
    const indexWithCaptions = {
      ...timelineIndex,
      visionCaptions: [
        { timestampSec: 5, sceneId: "clip01_scene001", caption: "wczesna klatka" },
        { timestampSec: 12, sceneId: "clip01_scene001", caption: "vlog w pokoju — final" },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex: indexWithCaptions,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    const scene1 = brief.sceneMap.find((entry) => entry.sceneId === "clip01_scene001");
    assert.equal(scene1.visionCaption, "vlog w pokoju — final");
  });

  it("includes objectLabels in sceneMap from timeline objectDetections", () => {
    const indexWithObjects = {
      ...timelineIndex,
      objectDetections: [
        { sceneId: "clip01_scene001", label: "laptop", timestampSec: 2 },
        { sceneId: "clip01_scene001", label: "laptop", timestampSec: 4 },
        { sceneId: "clip01_scene001", label: "coffee", timestampSec: 6 },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex: indexWithObjects,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    const scene1 = brief.sceneMap.find((entry) => entry.sceneId === "clip01_scene001");
    assert.deepEqual(scene1.objectLabels, ["laptop", "coffee"]);
  });

  it("enriches clipRegistry with L1-derived signals in brief", () => {
    const enrichedAbstraction = {
      ...abstraction,
      L1: [
        {
          sceneId: "clip01_scene001",
          brollPotential: 0.2,
          topics: ["vlog", "pokój"],
          mood: "spokojny",
        },
        {
          sceneId: "clip02_scene001",
          brollPotential: 0.9,
          topics: ["jedzenie"],
          isNarrationSource: false,
        },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction: enrichedAbstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    const clip01 = brief.clipRegistry.find((c) => c.clipId === "clip01");
    assert.equal(clip01.l1SceneCount, 1);
    assert.ok(clip01.l1AvgBrollPotential >= 0);
    assert.deepEqual(clip01.l1Topics, ["vlog", "pokój"]);
    assert.equal(clip01.l1DominantMood, "spokojny");
  });

  it("includes audioEventAnchors in brief when perClipAnalysis has events", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      perClipAnalysis: [{
        clipId: "clip01",
        audioEvents: [
          { startSec: 5, label: "Laughter", score: 0.8 },
          { startSec: 50, label: "Impact", score: 0.4 },
        ],
      }],
    });

    assert.ok(brief.audioEventAnchors?.length >= 1);
    assert.equal(brief.audioEventAnchors[0].label, "Laughter");
    assert.equal(brief.audioEventAnchors[0].sceneId, "clip01_scene001");
  });

  it("buildAudioEventAnchors sorts by strength and limits count", () => {
    const anchors = buildAudioEventAnchors(timelineIndex, [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 1, label: "low", score: 0.2 },
        { startSec: 2, label: "high", score: 0.9 },
      ],
    }], { limit: 1 });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].label, "high");
  });

  it("includes spatial anchors in director brief spatialIndex", () => {
    const multiAnchorSpatial = {
      version: "1.0",
      batchId: "testbatch",
      scenes: [
        {
          sceneId: "clip01_scene001",
          anchors: [
            { type: "face", bbox: [0.1, 0.1, 0.2, 0.2], timestampSec: 1, label: "face", confidence: 0.9 },
            { type: "subject", bbox: [0.2, 0.25, 0.4, 0.5], timestampSec: 5, label: "person", confidence: 0.8 },
          ],
        },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex: multiAnchorSpatial,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.spatialIndex.scenes[0].anchors.length, 2);
    assert.equal(brief.spatialIndex.scenes[0].primaryAnchor.type, "face");
  });

  it("omits l1SceneSummaries when batch has more than 30 scenes", () => {
    const manyScenes = Array.from({ length: 31 }, (_, i) => ({
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

  it("does not compact sceneMap for multi-clip batches below dynamic threshold", () => {
    const manyScenes = Array.from({ length: 25 }, (_, i) => ({
      sceneId: `clip${i < 2 || i === 24 ? "01" : "02"}_scene${String(i + 1).padStart(3, "0")}`,
      clipId: i < 2 || i === 24 ? "clip01" : "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
      aspectRatio: "16:9",
      hasSpeech: i === 0 || i === 24,
    }));

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

    const brief = buildDirectorBrief({
      abstraction: { ...abstraction, L1: manyScenes.map((scene, i) => ({ sceneId: scene.sceneId, brollPotential: 0.1 })) },
      timelineIndex: {
        ...timelineIndex,
        clips: [
          { clipId: "clip01", durationSec: 30 },
          { clipId: "clip02", durationSec: 230 },
        ],
        scenes: manyScenes,
      },
      clipRegistry: mixedClipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.sceneMapPolicy, undefined);
    assert.equal(brief.sceneMap.length, 25);
  });

  it("uses compact sceneMap for large multi-clip batches", () => {
    const manyScenes = Array.from({ length: 75 }, (_, i) => ({
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
    assert.ok(brief.sceneMap.length < 75);
    assert.ok(brief.sceneMapOmittedScenes?.length > 0);
    assert.ok(brief.sceneMapOmittedScenes.every((entry) => entry.sceneId && entry.clipId));
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
    assert.ok(
      brief.sceneMapAutoExpandedCount == null || brief.sceneMapAutoExpandedCount >= 0,
      "compact batches may report auto-expansion count",
    );
  });

  it("expandCompactSceneMapSelection adds topic anchors and high-broll scenes", () => {
    const scenes = Array.from({ length: 40 }, (_, i) => ({
      sceneId: `clip${i < 5 ? "01" : "02"}_scene${String(i + 1).padStart(3, "0")}`,
      clipId: i < 5 ? "clip01" : "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      hasSpeech: i === 0,
    }));
    const index = { scenes };
    const abs = {
      L1: scenes.map((scene, i) => ({
        sceneId: scene.sceneId,
        brollPotential: i === 15 ? 0.95 : 0.2,
        topics: i === 15 ? ["jedzenie"] : [],
      })),
    };
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "jedzenie",
        matchingScenes: [{ sceneId: "clip02_scene016", score: 0.9 }],
      }],
    };
    const ranks = [{ sceneId: "clip02_scene020", score: 0.8 }];
    const baseSelected = scenes.slice(0, 8);

    const expanded = expandCompactSceneMapSelection({
      selectedScenes: baseSelected,
      timelineIndex: index,
      abstraction: abs,
      topicIndex,
      sceneRanks: ranks,
      compactThreshold: 20,
    });

    assert.ok(expanded.length > baseSelected.length);
    assert.ok(expanded.some((scene) => scene.sceneId === "clip02_scene016"));
    assert.ok(expanded.some((scene) => scene.sceneId === "clip02_scene020"));
    assert.ok(expanded.length <= 20);
  });

  it("includes brollStrategy in brief constraints", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      batchContext: { brollStrategy: "minimal" },
    });

    assert.equal(brief.constraints.brollStrategy, "minimal");
    assert.equal(brief.brollSyncHints, undefined);
  });

  it("includes daySegments for multi-clip registry with creationTime", () => {
    const multiRegistry = [
      {
        clipId: "clip01",
        fileName: "01.mov",
        durationSec: 100,
        sortIndex: 0,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 10,
        creationTime: "2026-06-29T08:00:00.000Z",
      },
      {
        clipId: "clip02",
        fileName: "02.mov",
        durationSec: 50,
        sortIndex: 1,
        clipRole: "broll_pool",
        hasSpeech: false,
        speechWordCount: 0,
        creationTime: "2026-06-29T18:00:00.000Z",
      },
    ];

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex: {
        ...timelineIndex,
        clips: [
          { clipId: "clip01", durationSec: 100 },
          { clipId: "clip02", durationSec: 50 },
        ],
      },
      clipRegistry: multiRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(brief.daySegments);
    assert.equal(brief.daySegments[0].clipIds.length, 2);
    assert.equal(brief.clipRegistry[0].creationTime, "2026-06-29T08:00:00.000Z");
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
      "s_skip",
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
