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
  buildEmotionalBeatHints,
  resolveSceneMapCompactThreshold,
  shouldRunDirectorDrillDown,
  prioritizeDrillDownSceneIds,
  DRILL_DOWN_SCENE_CAP,
  backfillDirectorDraftContext,
  resolveDirectorBriefUserContext,
  ensureTimelineAudioPolicies,
  sanitizeDirectorDraft,
  sanitizeRenderStylePresets,
  sanitizeShortsOutroBracket,
} from "./director.js";
import {
  EditRecipeV2Schema,
  RenderStylePresetsSchema,
  ShortsOutroBracketSchema,
} from "../schemas/edit-recipe-v2.js";
import { DIRECTOR_BRIEF_CAPS, DRILL_DOWN_CAPS } from "../editorial/brief-caps.js";
import { buildAudioIndexSummary } from "../editorial/audio-index-summary.js";
import { MODELS } from "./openai-client.js";
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

  it("uses safety display text in LLM transcript excerpts", () => {
    const excerpts = buildTranscriptExcerpts({
      scenes: [{
        sceneId: "clip01_scene001",
        clipId: "clip01",
        startSec: 0,
        endSec: 2,
        hasSpeech: true,
      }],
      words: [{
        wordId: "clip01_w001",
        word: "morderca",
        displayWord: "m******a",
        safetyClass: "sensitive",
        safetyAction: "bleep",
        start: 0.5,
        end: 1,
      }],
    });

    assert.equal(excerpts[0].words[0].word, "m******a");
    assert.equal(excerpts[0].words[0].safetyClass, "sensitive");
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
    assert.ok(brief.sfxCatalogSummary[0].title);
    assert.ok(Array.isArray(brief.sfxCatalogSummary[0].tags));
    assert.ok("suggestedVolumeDb" in brief.sfxCatalogSummary[0]);
  });

  it("includes generated hook provenance and actual TwelveLabs understanding", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [
        ...clipRegistry,
        {
          clipId: "ai_hook_01",
          fileName: "ai_hook_01.mp4",
          durationSec: 5,
          sortIndex: 1,
          clipRole: "ai_generated",
        },
      ],
      topicIndex,
      requiredFormats: ["9:16"],
      aiVideoArtifact: {
        status: "succeeded",
        provider: "kling",
        model: "kling-v3",
        clipId: "ai_hook_01",
        sceneId: "ai_hook_01_scene001",
        durationSec: 5,
        prompt: "Cinematic bicycle summit reveal",
        plan: {
          hookSceneId: "clip01_scene002",
          firstFrameSec: 9.75,
          lastFrameSec: 10,
          generateAudio: false,
        },
        twelveLabsAnalysis: {
          status: "succeeded",
          mode: "live",
          clipSummary: "Rowerzysta dynamicznie wjeżdża na szczyt.",
          editorial: { mood: "triumphant" },
        },
      },
    });

    assert.equal(brief.aiHook.clipId, "ai_hook_01");
    assert.equal(brief.aiHook.fixedAsset, true);
    assert.equal(brief.aiHook.generatedAudio, false);
    assert.equal(
      brief.aiHook.understanding.clipSummary,
      "Rowerzysta dynamicznie wjeżdża na szczyt.",
    );
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

  it("includes emotionalBeatHints for dramatic/cinematic/tense L1 moods", () => {
    const richAbstraction = {
      ...abstraction,
      L1: [
        {
          sceneId: "clip01_scene001",
          summary: "Kulminacja napięcia.",
          mood: "dramatic",
          keyMoments: ["reveal"],
        },
        {
          sceneId: "clip01_scene002",
          summary: "Kontynuacja vloga na zewnątrz.",
          mood: "energetyczny",
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

    assert.ok(Array.isArray(brief.emotionalBeatHints));
    assert.equal(brief.emotionalBeatHints.length, 1);
    assert.equal(brief.emotionalBeatHints[0].sceneId, "clip01_scene001");
    assert.equal(brief.emotionalBeatHints[0].clipId, "clip01");
    assert.equal(brief.emotionalBeatHints[0].mood, "dramatic");
    assert.equal(brief.emotionalBeatHints[0].retentionRole, "payoff");
    assert.equal(brief.emotionalBeatHints[0].suggestedTechniqueId, "music_drop");
    assert.deepEqual(brief.emotionalBeatHints[0].keyMoments, ["reveal"]);
    assert.ok(brief.emotionalBeatHints[0].anchorTimeSec > 0);
    assert.match(brief.emotionalBeatHints[0].suggestion, /payoff/);

    const cinematicHints = buildEmotionalBeatHints(
      { L1: [{ sceneId: "clip01_scene002", mood: "cinematic" }] },
      timelineIndex,
    );
    assert.equal(cinematicHints.length, 1);
    assert.equal(cinematicHints[0].retentionRole, "payoff");

    const tenseHints = buildEmotionalBeatHints(
      { L1: [{ sceneId: "clip01_scene002", mood: "tense" }] },
      timelineIndex,
    );
    assert.equal(tenseHints.length, 1);

    const noHints = buildEmotionalBeatHints(
      { L1: [{ sceneId: "clip01_scene001", mood: "luźny" }] },
      timelineIndex,
    );
    assert.equal(noHints.length, 0);
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

    assert.equal(brief.version, "2.5");
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

  it("includes top-ranked l1SceneSummaries for large batches", () => {
    const manyScenes = Array.from({ length: 31 }, (_, i) => ({
      sceneId: `clip01_scene${String(i + 1).padStart(3, "0")}`,
      clipId: "clip01",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
      aspectRatio: "16:9",
      hasSpeech: i % 2 === 0,
    }));
    const manyL1 = manyScenes.map((scene, i) => ({
      sceneId: scene.sceneId,
      summary: `scene ${i + 1}`,
      brollPotential: i === 0 ? 0.95 : 0.2,
      visualQuality: i === 0 ? "high" : "medium",
    }));
    const manyIndex = {
      ...timelineIndex,
      scenes: manyScenes,
    };

    const brief = buildDirectorBrief({
      abstraction: { ...abstraction, L1: manyL1 },
      timelineIndex: manyIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.l1SceneSummaries.length, 30);
    assert.ok(brief.l1SceneSummaries.some((entry) => entry.sceneId === "clip01_scene001"));
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
    assert.ok(
      brief.sceneMapOmittedScenes.every(
        (entry) => entry.startSec != null && entry.endSec != null,
      ),
    );
    const omittedWithSummary = brief.sceneMapOmittedScenes.find((entry) => entry.summary);
    if (omittedWithSummary) {
      assert.ok(omittedWithSummary.summary.length <= DIRECTOR_BRIEF_CAPS.OMITTED_SUMMARY_MAX_CHARS);
    }
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

  it("includes brollSyncHints when topic index has matches and recipe is null", () => {
    const topicWithMatches = {
      version: "1.0",
      batchId: "testbatch",
      topics: [{
        topicId: "topic_coffee",
        label: "coffee",
        wordIds: [],
        timeRange: { clipId: "clip01", startSec: 0, endSec: 10 },
        matchingScenes: [{ sceneId: "clip01_scene001", score: 0.85 }],
      }],
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: topicWithMatches,
      requiredFormats: ["16:9", "9:16"],
      recipe: null,
    });

    assert.ok(Array.isArray(brief.brollSyncHints));
    assert.ok(brief.brollSyncHints.length > 0);
    assert.equal(brief.brollSyncHints[0].sceneId, "clip01_scene001");
    assert.ok(brief.brollSyncHints.length <= DIRECTOR_BRIEF_CAPS.BROLL_SYNC_HINTS_LIMIT);
  });

  it("includes voiceDirectivePolicy in brief constraints", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.equal(brief.constraints.voiceDirectivePolicy, "enricher_materializes");
    assert.equal(brief.voiceDirectives, undefined);
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

  it("includes enhancementCandidates from perClipAnalysis audioQuality", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      perClipAnalysis: [{
        clipId: "clip01",
        audioQuality: {
          assessmentVersion: "1.0",
          mode: "heuristic",
          hasSpeech: true,
          qualityScore: 0.4,
          grade: "poor",
          enhancementRecommended: true,
          enhancementCandidateId: "enh_clip01",
          reasons: ["low_snr"],
          issues: ["low_snr"],
        },
      }],
    });

    assert.equal(brief.version, "2.5");
    assert.equal(brief.enhancementCandidates.length, 1);
    assert.equal(brief.enhancementCandidates[0].candidateId, "enh_clip01");
  });

  it("includes engagementRepairCandidates from deliveryAnalysis", () => {
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      perClipAnalysis: [{
        clipId: "clip01",
        deliveryAnalysis: {
          assessmentVersion: "1.0",
          mode: "heuristic",
          windows: [],
          clipSummary: {
            engagementGrade: "flat",
            engagementScore: 0.32,
            dominantIssues: ["flat_pitch"],
            flatWindowCount: 1,
            flatDeliveryWindows: [{
              startSec: 10,
              endSec: 15,
              engagementScore: 0.28,
              issues: ["flat_pitch"],
            }],
          },
        },
      }],
    });

    assert.equal(brief.engagementRepairCandidates.length, 1);
    assert.equal(brief.engagementRepairCandidates[0].candidateId, "delivery_clip01");
    assert.ok(brief.engagementRepairCandidates[0].recommendedRepairs.includes("editorial_pacing"));
  });

  it("derives narrativeProfile from L2 narrativeRole when not explicitly set", () => {
    const abstractionWithRoles = {
      ...abstraction,
      L2: [
        { segmentId: "seg001", narrativeRole: "tension", summary: "Rising action" },
        { segmentId: "seg002", narrativeRole: "breath", summary: "Quiet moment" },
      ],
    };

    const brief = buildDirectorBrief({
      abstraction: abstractionWithRoles,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
    });

    assert.ok(brief.narrativeProfile);
    assert.equal(brief.narrativeProfile.segments.length, 2);

    const byId = Object.fromEntries(
      brief.narrativeProfile.segments.map((entry) => [entry.l2SegmentId, entry]),
    );
    assert.equal(byId.seg001.rhythm, "fast");
    assert.equal(byId.seg001.retentionIntensity, "high");
    assert.equal(byId.seg002.rhythm, "slow");
    assert.equal(byId.seg002.retentionIntensity, "low");
    assert.equal(byId.seg002.silencePolicy, "preserve");

    assert.ok(brief.creativityBudgetByL2Segment);
    assert.equal(brief.creativityBudgetByL2Segment.seg001.maxZoomMoments, 8);
    assert.equal(brief.creativityBudgetByL2Segment.seg002.maxZoomMoments, 0);
    assert.ok(
      brief.creativityBudgetByL2Segment.seg002.minZoomGapSec
        > brief.creativityBudgetByL2Segment.seg001.minZoomGapSec,
    );
  });

  it("includes narrativeProfile in brief when provided", () => {
    const narrativeProfile = {
      mode: "internet_documentary",
      segments: [{ l2SegmentId: "seg001", rhythm: "slow", retentionIntensity: "low" }],
      maxPatternInterruptsPer10Min: 1,
      sfxNarrativeOnly: true,
    };
    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      requiredFormats: ["16:9"],
      narrativeProfile,
    });

    assert.deepEqual(brief.narrativeProfile, narrativeProfile);
  });

  it("filters sfxPlanDefaults when sfxNarrativeOnly and no narrative anchors", () => {
    const perClipAnalysis = [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 0.5, endSec: 1.1, label: "Laughter", score: 0.74 },
        { startSec: 22.0, endSec: 22.4, label: "Laughter", score: 0.8 },
      ],
    }];

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex: { clips: [{ clipId: "clip01", editorialTags: ["laughter"] }] },
      perClipAnalysis,
      requiredFormats: ["16:9"],
      narrativeProfile: { sfxNarrativeOnly: true },
    });

    assert.equal(brief.sfxPlanDefaults.length, 0);
  });

  it("filters sfxPlanDefaults to hook-adjacent events when sfxNarrativeOnly", () => {
    const perClipAnalysis = [{
      clipId: "clip01",
      audioEvents: [
        { startSec: 0.5, endSec: 1.1, label: "Laughter", score: 0.74 },
        { startSec: 22.0, endSec: 22.4, label: "Laughter", score: 0.8 },
      ],
    }];

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex: { clips: [{ clipId: "clip01", editorialTags: ["laughter"] }] },
      perClipAnalysis,
      requiredFormats: ["16:9"],
      narrativeProfile: { sfxNarrativeOnly: true },
      recipe: {
        outputs: [{
          outputId: "main_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: [{
            segmentId: "seg_body",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 240,
            audioInSec: 0,
            audioOutSec: 240,
            audioPolicy: "from_video_ref",
            outputStartSec: 0,
            outputEndSec: 240,
          }],
        }],
        creativeMoments: [{
          momentId: "hook_01",
          techniqueId: "snap_zoom",
          retentionRole: "hook",
          outputId: "main_16x9",
          outputStartSec: 0,
          outputEndSec: 2,
        }],
      },
    });

    assert.equal(brief.sfxPlanDefaults.length, 1);
    assert.equal(brief.sfxPlanDefaults[0].anchorTimeSec, 0.5);
  });

  it("applies narrativeProfile silence taxonomy to brief audioIndex", () => {
    const highEnergyCurve = [
      { startSec: 0, endSec: 2, rmsDb: -16 },
      { startSec: 2, endSec: 6, rmsDb: -42 },
      { startSec: 6, endSec: 8, rmsDb: -12 },
    ];
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    }];
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
      energyCurve: highEnergyCurve,
    }];
    const narrativeProfile = { silencePolicy: "preserve" };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      audioIndex: { clips: [{ clipId: "clip01" }], batchSummary: { dominantMood: "dramatic" } },
      perClipAnalysis,
      wordIndexes,
      requiredFormats: ["16:9"],
      narrativeProfile,
    });

    const hint = brief.audioIndex.clips[0].deadAirHints?.find((h) => h.startSec === 2);
    assert.equal(hint?.silenceKind, "dramatic_pause");
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

    const draftResult = await runDirector(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex,
      spatialIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9", "9:16"],
    });

    const draft = draftResult.recipe;
    assert.equal(draft.version, "2.0");
    assert.equal(draft.outputs.length, 2);
    assert.equal(draft.outputs[0].timeline[0].videoRef.sceneId, "clip01_scene001");
    assert.equal(draft.outputs[0].timeline[0].segmentRole, "aroll");

    const sceneIds = draft.outputs.flatMap((o) =>
      o.timeline.flatMap((s) => [s.videoRef.sceneId, s.audioRef.sceneId]),
    );
    const { recipe: refined } = await directorDrillDown(client, {
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
    assert.equal(client.getCapturedRequests()[0].model, MODELS.director);
    assert.equal(drillDownRequest.model, MODELS.directorDrillDown);
    const drillDownPayload = JSON.parse(drillDownRequest.messages[1].content);
    assert.equal(drillDownPayload.task, "drill_down_refine");
    assert.equal(drillDownPayload.sceneSummariesL1.length, 2);
    assert.deepEqual(drillDownPayload.topicIndex, topicIndex);
    assert.equal(drillDownPayload.drillDownSceneDetails.length, 2);
    assert.ok(drillDownPayload.techniqueCatalog);
    assert.ok(drillDownPayload.draftRecipeFingerprint);
    assert.equal(drillDownPayload.draftRecipe, undefined);
    assert.equal(drillDownPayload.outputSchema, undefined);
    assert.ok(drillDownPayload.creativityProfile);
    assert.ok(drillDownPayload.creativityBudget);
    assert.equal(drillDownPayload.spatialIndex.scenes.length, 1);
    assert.equal(drillDownPayload.spatialIndex.scenes[0].sceneId, "clip01_scene001");
    assert.ok(Array.isArray(drillDownPayload.spatialRefExamples));
    assert.equal(drillDownPayload.transcriptExcerpts.length, 2);
    assert.deepEqual(drillDownPayload.audioIndex.clips[0].beatTimestamps, [0.5, 1.0, 1.5]);
  });

  it("directorDrillDown uses DRILL_DOWN_CAPS aligned with DIRECTOR_BRIEF_CAPS", () => {
    assert.deepEqual(DRILL_DOWN_CAPS, DIRECTOR_BRIEF_CAPS);
    assert.equal(DRILL_DOWN_CAPS.maxWordsPerScene, 120);
    assert.equal(DRILL_DOWN_CAPS.spatialAnchorLimit, 3);
  });

  it("directorDrillDown includes voiceDirectivePolicy instead of voiceDirectives", async () => {
    const refinedRecipe = loadFixture("fixer-response.json");
    const client = createMockOpenAIClient([refinedRecipe], { captureRequests: true });
    const draft = loadFixture("recipe-draft.json");
    const sceneIds = ["clip01_scene001", "clip01_scene002"];

    await directorDrillDown(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex,
      userContext: "dzień 66",
      requiredFormats: ["16:9", "9:16"],
      recipe: draft,
      sceneIds,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.constraints.voiceDirectivePolicy, "enricher_materializes");
    assert.equal(payload.voiceDirectives, undefined);
  });

  it("directorDrillDown omits voiceDirectives when meta commands empty", async () => {
    const refinedRecipe = loadFixture("fixer-response.json");
    const client = createMockOpenAIClient([refinedRecipe], { captureRequests: true });
    const draft = loadFixture("recipe-draft.json");
    const sceneIds = ["clip01_scene001", "clip01_scene002"];

    await directorDrillDown(client, {
      abstraction,
      timelineIndex,
      clipRegistry,
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      audioIndex,
      userContext: "",
      requiredFormats: ["16:9", "9:16"],
      recipe: draft,
      sceneIds,
    });

    const payload = JSON.parse(client.getCapturedRequests()[0].messages[1].content);
    assert.equal(payload.constraints.voiceDirectivePolicy, "enricher_materializes");
    assert.equal(payload.voiceDirectives, undefined);
  });

  describe("shouldRunDirectorDrillDown", () => {
    function segment(overrides = {}) {
      return {
        segmentId: "seg_1",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        cuts: [],
        ...overrides,
      };
    }

    function recipeWithSegments(segments) {
      return {
        outputs: [{ outputId: "main", timeline: segments }],
      };
    }

    it("skips when batchContext.skipDrillDown is true", () => {
      const recipe = recipeWithSegments([
        segment({ videoRef: { clipId: "clip01", sceneId: "s1" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, { skipDrillDown: true }), false);
    });

    it("skips when unique scene count is 3 or fewer", () => {
      const recipe = recipeWithSegments([
        segment({ videoRef: { clipId: "clip01", sceneId: "s1" }, audioRef: { clipId: "clip01", sceneId: "s1" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}), false);
    });

    it("runs when cross-clip B-roll exists", () => {
      const recipe = recipeWithSegments([
        segment({
          videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" }, audioRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}), true);
    });

    it("runs when any segment has cuts", () => {
      const recipe = recipeWithSegments([
        segment({ cuts: [{ cutId: "c1", atSec: 1 }] }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" }, audioRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}), true);
    });

    it("runs when scene count exceeds 12", () => {
      const segments = Array.from({ length: 13 }, (_, i) => segment({
        videoRef: { clipId: "clip01", sceneId: `s${i + 1}` },
        audioRef: { clipId: "clip01", sceneId: `s${i + 1}` },
      }));
      assert.equal(shouldRunDirectorDrillDown(recipeWithSegments(segments), {}), true);
    });

    it("skips otherwise for medium recipes without cuts or cross-clip B-roll", () => {
      const segments = Array.from({ length: 8 }, (_, i) => segment({
        videoRef: { clipId: "clip01", sceneId: `s${i + 1}` },
        audioRef: { clipId: "clip01", sceneId: `s${i + 1}` },
      }));
      assert.equal(shouldRunDirectorDrillDown(recipeWithSegments(segments), {}), false);
    });

    it("runs when meta commands exist", () => {
      const recipe = recipeWithSegments([
        segment({ videoRef: { clipId: "clip01", sceneId: "s1" }, audioRef: { clipId: "clip01", sceneId: "s1" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" }, audioRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}, {
        metaCommandsByClip: [{ clipId: "clip01", commands: [{ type: "boomerang" }] }],
      }), true);
    });

    it("runs when fillerWordCount is at least 5", () => {
      const recipe = recipeWithSegments([
        segment({ videoRef: { clipId: "clip01", sceneId: "s1" }, audioRef: { clipId: "clip01", sceneId: "s1" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" }, audioRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}, {
        timelineIndex: { stats: { fillerWordCount: 5 } },
      }), true);
    });

    it("runs when deadAirHints count is at least 2", () => {
      const recipe = recipeWithSegments([
        segment({ videoRef: { clipId: "clip01", sceneId: "s1" }, audioRef: { clipId: "clip01", sceneId: "s1" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s2" }, audioRef: { clipId: "clip01", sceneId: "s2" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s3" }, audioRef: { clipId: "clip01", sceneId: "s3" } }),
        segment({ videoRef: { clipId: "clip01", sceneId: "s4" }, audioRef: { clipId: "clip01", sceneId: "s4" } }),
      ]);
      assert.equal(shouldRunDirectorDrillDown(recipe, {}, {
        audioIndex: {
          clips: [{
            clipId: "clip01",
            deadAirHints: [{ startSec: 1, endSec: 2 }, { startSec: 3, endSec: 4 }],
          }],
        },
      }), true);
    });
  });

  it("resolveSceneMapCompactThreshold scales with clip and scene count", () => {
    const singleClip = resolveSceneMapCompactThreshold(
      { clips: [{ clipId: "clip01" }], scenes: Array.from({ length: 20 }) },
      "single_clip",
    );
    assert.equal(singleClip, 40);

    const largeBatch = resolveSceneMapCompactThreshold(
      { clips: [{ clipId: "clip01" }], scenes: Array.from({ length: 90 }) },
      "single_clip",
    );
    assert.equal(largeBatch, 50);

    const multiClip = resolveSceneMapCompactThreshold(
      {
        clips: [{ clipId: "clip01" }, { clipId: "clip02" }],
        scenes: Array.from({ length: 25 }),
      },
      "multi_clip_day",
    );
    assert.equal(multiClip, 70);
  });

  it("prioritizeDrillDownSceneIds caps at DRILL_DOWN_SCENE_CAP", () => {
    const sceneIds = Array.from({ length: 20 }, (_, i) => `scene_${String(i).padStart(3, "0")}`);
    const recipe = {
      outputs: [{
        timeline: [
          {
            videoRef: { clipId: "clip01", sceneId: "scene_000" },
            audioRef: { clipId: "clip02", sceneId: "scene_000" },
            cuts: [{ cutId: "c1" }],
          },
        ],
      }],
    };

    const prioritized = prioritizeDrillDownSceneIds(
      recipe,
      sceneIds,
      abstraction,
      timelineIndex,
    );

    assert.equal(prioritized.length, DRILL_DOWN_SCENE_CAP);
    assert.ok(prioritized.includes("scene_000"));
  });

  it("prioritizeDrillDownSceneIds returns all scenes when under cap", () => {
    const sceneIds = ["clip01_scene001", "clip01_scene002"];
    const prioritized = prioritizeDrillDownSceneIds(
      recipeDraft,
      sceneIds,
      abstraction,
      timelineIndex,
    );
    assert.deepEqual(prioritized, sceneIds);
  });

  it("backfillDirectorDraftContext fills batchContext and ai_hook audioPolicy", () => {
    const priorRecipe = loadFixture("recipe-draft.json");
    const raw = structuredClone(loadFixture("fixer-response.json"));
    delete raw.batchContext;
    for (const output of raw.outputs ?? []) {
      for (const segment of output.timeline ?? []) {
        if (segment.segmentRole === "ai_hook") {
          delete segment.audioPolicy;
        }
      }
    }

    backfillDirectorDraftContext(raw, {
      priorRecipe,
      batchContext: priorRecipe.batchContext,
      requiredFormats: ["16:9", "9:16"],
      inputMode: "single_clip",
    });

    assert.ok(raw.batchContext);
    assert.deepEqual(raw.batchContext.requiredFormats, ["16:9", "9:16"]);
    const parsed = EditRecipeV2Schema.parse(raw);
    assert.ok(parsed.batchContext);
  });

  it("backfillDirectorDraftContext overwrites LLM single_clip with orchestrator multi_clip_day", () => {
    const raw = {
      batchContext: {
        inputMode: "single_clip",
        requiredFormats: ["16:9"],
        theme: "vlog",
      },
      outputs: [],
    };

    backfillDirectorDraftContext(raw, {
      priorRecipe: null,
      batchContext: { inputMode: "multi_clip_day", theme: "vlog" },
      requiredFormats: ["16:9", "9:16"],
      inputMode: "multi_clip_day",
    });

    assert.equal(raw.batchContext.inputMode, "multi_clip_day");
    assert.deepEqual(raw.batchContext.requiredFormats, ["16:9", "9:16"]);
  });

  it("backfillDirectorDraftContext overwrites even when priorRecipe also has single_clip", () => {
    const raw = {
      batchContext: { inputMode: "single_clip" },
      outputs: [],
    };

    backfillDirectorDraftContext(raw, {
      priorRecipe: { batchContext: { inputMode: "single_clip", theme: "day" } },
      batchContext: { theme: "day" },
      requiredFormats: ["16:9"],
      inputMode: "multi_clip_day",
    });

    assert.equal(raw.batchContext.inputMode, "multi_clip_day");
  });

  it("backfillDirectorDraftContext preserves orchestrator notes over LLM batchContext", () => {
    const raw = {
      batchContext: {
        inputMode: "multi_clip_day",
        notes: "LLM invented notes",
        theme: "wrong",
      },
      outputs: [],
    };

    backfillDirectorDraftContext(raw, {
      batchContext: {
        inputMode: "multi_clip_day",
        notes: "Orchestrator brief from manifest",
        theme: "travel",
      },
      inputMode: "multi_clip_day",
    });

    assert.equal(raw.batchContext.notes, "Orchestrator brief from manifest");
    assert.equal(raw.batchContext.theme, "wrong");
  });

  it("resolveDirectorBriefUserContext falls back when composed context is metadata-only", () => {
    const resolved = resolveDirectorBriefUserContext(
      "segment:seg002\ntheme:vlog\ntarget_keep_ratio:0.4",
      "User wants a fast-paced day recap",
    );
    assert.equal(resolved, "User wants a fast-paced day recap");
  });

  it("buildDirectorBrief uses timeline userContext when segment metadata is context-free", () => {
    const abstraction = loadFixture("abstraction.json");
    const timelineIndex = {
      ...loadFixture("timeline-index.json"),
      userContext: "Highlight the restaurant scene and skip setup",
    };

    const brief = buildDirectorBrief({
      abstraction,
      timelineIndex,
      clipRegistry: [{ clipId: "clip01", sortIndex: 0 }],
      topicIndex: { topics: [] },
      spatialIndex: { scenes: [] },
      userContext: "segment:seg001\ntheme:vlog",
      requiredFormats: ["16:9"],
      batchContext: {},
    });

    assert.match(brief.userContext, /restaurant scene/);
    assert.equal(brief.userContext.includes("segment:seg001"), false);
  });

  const minimalPriorOutputs = () => ([
    {
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      targetDurationSec: 60,
      title: "Main",
      synopsis: "Test",
      timeline: [{
        segmentId: "seg_main_1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        cuts: [],
        textOverlays: [],
      }],
      chapterMarkers: [],
    },
  ]);

  it("backfillDirectorDraftContext restores missing outputs from priorRecipe (deep clone)", () => {
    const priorRecipe = { outputs: minimalPriorOutputs() };
    const raw = { batchContext: { theme: "vlog" } };

    backfillDirectorDraftContext(raw, { priorRecipe });

    assert.equal(raw.outputs.length, 1);
    assert.equal(raw.outputs[0].outputId, "main_16x9");
    priorRecipe.outputs[0].title = "mutated";
    assert.equal(raw.outputs[0].title, "Main");
  });

  it("backfillDirectorDraftContext restores empty outputs array from priorRecipe", () => {
    const priorRecipe = { outputs: minimalPriorOutputs() };
    const raw = { outputs: [], batchContext: { theme: "vlog" } };

    backfillDirectorDraftContext(raw, { priorRecipe });

    assert.equal(raw.outputs.length, 1);
    assert.equal(raw.outputs[0].outputId, "main_16x9");
  });

  it("backfillDirectorDraftContext keeps existing outputs when non-empty", () => {
    const priorRecipe = { outputs: minimalPriorOutputs() };
    const raw = {
      outputs: [{
        outputId: "short_9x16",
        format: "9:16",
        outputKind: "short",
        targetDurationSec: 30,
        title: "Short",
        synopsis: "Keep me",
        timeline: [{
          segmentId: "seg_short_1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          audioPolicy: "from_video_ref",
          overlapSec: 0,
          cuts: [],
          textOverlays: [],
        }],
        chapterMarkers: [],
      }],
    };

    backfillDirectorDraftContext(raw, { priorRecipe });

    assert.equal(raw.outputs.length, 1);
    assert.equal(raw.outputs[0].outputId, "short_9x16");
  });

  it("backfillDirectorDraftContext strips spurious top-level segmentId", () => {
    const priorRecipe = { outputs: minimalPriorOutputs() };
    const raw = { segmentId: "seg001", batchContext: { theme: "vlog" } };

    backfillDirectorDraftContext(raw, { priorRecipe });

    assert.equal(raw.segmentId, undefined);
    assert.equal(raw.outputs.length, 1);
  });

  it("ensureTimelineAudioPolicies defaults ai_hook to from_next", () => {
    const raw = {
      outputs: [{
        outputId: "short",
        format: "9:16",
        timeline: [{
          segmentId: "hook_1",
          segmentRole: "ai_hook",
          videoRef: { clipId: "ai_hook_01", sceneId: "ai_hook_01_scene001" },
          audioRef: { clipId: "clip28", sceneId: "clip28_scene001" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 5,
          overlapSec: 0,
          cuts: [],
          textOverlays: [],
        }],
      }],
    };

    ensureTimelineAudioPolicies(raw);
    assert.equal(raw.outputs[0].timeline[0].audioPolicy, "from_next");
  });

  it("sanitizeRenderStylePresets backfills width/height and converts safeArea", () => {
    const presets = {
      subtitles: { presetId: "default" },
      formats: {
        "16:9": { safeArea: 0.08 },
        "9:16": { safeArea: 0.1 },
      },
    };

    sanitizeRenderStylePresets(presets);

    assert.equal(presets.formats["16:9"].width, 1920);
    assert.equal(presets.formats["16:9"].height, 1080);
    assert.equal(presets.formats["16:9"].safeArea, undefined);
    assert.equal(presets.formats["9:16"].width, 1080);
    assert.equal(presets.formats["9:16"].height, 1920);
    assert.deepEqual(presets.formats["9:16"].safeZone, {
      top: 192,
      bottom: 192,
      left: 108,
      right: 108,
    });
    RenderStylePresetsSchema.parse(presets);
  });

  it("sanitizeDirectorDraft allows drill-down renderStylePresets + L3 verdict aliases to parse", () => {
    const raw = {
      version: "2.5",
      batchId: "51cd206d",
      batchContext: {
        inputMode: "multi_clip_day",
        requiredFormats: ["16:9", "9:16"],
      },
      clipRegistry: [],
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        title: "Main edit",
        timeline: [{
          segmentId: "seg001",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
        }],
      }],
      editorialAssessment: {
        verdict: "strong",
        summary: "Strong material with minor pacing issues.",
      },
      renderStylePresets: {
        subtitles: { presetId: "default" },
        formats: {
          "16:9": { safeArea: 0.08 },
          "9:16": { safeArea: 0.1 },
        },
      },
    };

    sanitizeDirectorDraft(raw);
    const parsed = EditRecipeV2Schema.parse(raw);
    assert.equal(parsed.editorialAssessment.verdict, "publishable_as_is");
    assert.equal(parsed.renderStylePresets.formats["16:9"].width, 1920);
    assert.equal(parsed.renderStylePresets.formats["9:16"].safeZone.top, 192);
  });

  it("sanitizeDirectorDraft rewrites mute ai_hook with audioOutSec=0", () => {
    const raw = {
      outputs: [{
        outputId: "short_9x16",
        format: "9:16",
        timeline: [{
          segmentId: "short_001",
          segmentRole: "ai_hook",
          videoRef: { clipId: "ai_hook_01", sceneId: "ai_hook_01" },
          audioRef: { clipId: "ai_hook_01", sceneId: "ai_hook_01" },
          videoInSec: 0,
          videoOutSec: 5,
          audioInSec: 0,
          audioOutSec: 0,
          audioPolicy: "mute",
        }],
      }],
    };

    sanitizeDirectorDraft(raw);
    const segment = raw.outputs[0].timeline[0];
    assert.equal(segment.audioPolicy, "from_next");
    assert.ok(segment.audioOutSec > 0);
    assert.equal(segment.audioOutSec, 5);
  });

  it("sanitizeShortsOutroBracket drops disabled empty stub (live seg001 shape)", () => {
    const raw = {
      shortsOutroBracket: {
        enabled: false,
        text: "",
        endAtOutputSec: 0,
        bracketDurationSec: 2.5,
        auto: false,
      },
    };

    sanitizeShortsOutroBracket(raw);
    assert.equal(raw.shortsOutroBracket, undefined);
  });

  it("ShortsOutroBracketSchema coerces empty text and non-positive end", () => {
    const parsed = ShortsOutroBracketSchema.parse({
      enabled: true,
      text: "",
      endAtOutputSec: 0,
      bracketDurationSec: 2.5,
    });
    assert.equal(parsed.text, undefined);
    assert.equal(parsed.endAtOutputSec, undefined);
    assert.equal(parsed.enabled, true);
  });

  it("sanitizeDirectorDraft allows live seg001 disabled bracket stub to parse", () => {
    const raw = {
      version: "2.5",
      batchId: "51cd206d",
      batchContext: {
        inputMode: "multi_clip_day",
        requiredFormats: ["16:9", "9:16"],
      },
      clipRegistry: [],
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        title: "Main edit",
        timeline: [{
          segmentId: "seg001",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
        }],
      }],
      shortsOutroBracket: {
        enabled: false,
        text: "",
        endAtOutputSec: 0,
        bracketDurationSec: 2.5,
        auto: false,
      },
    };

    sanitizeDirectorDraft(raw);
    assert.equal(raw.shortsOutroBracket, undefined);
    EditRecipeV2Schema.parse(raw);
  });
});
