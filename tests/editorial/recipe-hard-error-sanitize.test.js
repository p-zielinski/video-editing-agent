import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowRepeatedSceneReuse,
  sanitizeCreativeMomentDensity,
  sanitizeCreativityLevelGate,
  sanitizeDuplicateSameFormatOutputs,
  sanitizeExcludedClipUsage,
  sanitizeInvalidWordCuts,
  sanitizeMissingVlogRetentionBeats,
  sanitizeNarrativeBeatHardErrors,
  sanitizeAdjacentDuplicateSegments,
  sanitizeNarrativeCtaOverlays,
  sanitizeRecipeHardErrors,
  sanitizeSegmentSourceWindows,
  sanitizeStackedPayoffAudioDucks,
  sanitizeTailSourceVolumeDb,
  sanitizeTechniqueMomentCap,
  sanitizeUnmatchedBroll,
  sanitizeZoomDutyBudget,
} from "../../src/editorial/recipe-hard-error-sanitize.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";

describe("recipe-hard-error-sanitize", () => {
  it("drops cuts whose wordIds are from another clip", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentId: "seg1",
          videoRef: { clipId: "clip27", sceneId: "clip27_scene001" },
          audioRef: { clipId: "clip27", sceneId: "clip27_scene001" },
          cuts: [
            { startWordId: "clip02_w00000", endWordId: "clip02_w00001" },
            { startWordId: "clip27_w00010", endWordId: "clip27_w00012" },
          ],
        }],
      }],
    };

    sanitizeInvalidWordCuts(recipe);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].cuts[0].startWordId, "clip27_w00010");
  });

  it("marks duplicate scene uses with allowBrollReuse", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [
          {
            segmentId: "a",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
          },
          {
            segmentId: "b",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
          },
        ],
      }],
    };

    allowRepeatedSceneReuse(recipe);
    assert.equal(recipe.outputs[0].timeline[0].allowBrollReuse, undefined);
    assert.equal(recipe.outputs[0].timeline[1].allowBrollReuse, true);
  });

  it("sanitizeDuplicateSameFormatOutputs keeps canonical main_16x9 and remaps moments", () => {
    const recipe = {
      outputs: [
        {
          outputId: "output_0_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: [{
            segmentId: "seg_a",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            outputStartSec: 0,
            outputEndSec: 120,
          }],
        },
        {
          outputId: "main_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: [{
            segmentId: "seg_b",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            outputStartSec: 0,
            outputEndSec: 120,
          }],
        },
      ],
      creativeMoments: [{
        momentId: "cm_dup",
        techniqueId: "cut_on_beat",
        outputId: "output_0_16x9",
        outputStartSec: 30,
        outputEndSec: 30.5,
      }],
      retentionBeatTargets: [
        { outputId: "output_0_16x9", targetSec: 48 },
      ],
      audioMixPlan: {
        segments: [{ outputId: "output_0_16x9", musicInSec: 0, musicOutSec: 120 }],
      },
      sceneUsageRegistry: [
        { sceneId: "clip01_scene001", outputId: "output_0_16x9", format: "16:9" },
      ],
    };

    sanitizeDuplicateSameFormatOutputs(recipe);

    assert.equal(recipe.outputs.length, 1);
    assert.equal(recipe.outputs[0].outputId, "main_16x9");
    assert.equal(recipe.creativeMoments[0].outputId, "main_16x9");
    assert.equal(recipe.retentionBeatTargets[0].outputId, "main_16x9");
    assert.equal(recipe.audioMixPlan.segments[0].outputId, "main_16x9");
    assert.equal(recipe.sceneUsageRegistry[0].outputId, "main_16x9");
  });

  it("sanitizeCreativityLevelGate drops match_cut at balanced level", () => {
    const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
    const recipe = {
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{ outputStartSec: 0, outputEndSec: 120 }],
      }],
      creativeMoments: [
        {
          momentId: "enrich_callback_001",
          techniqueId: "match_cut",
          outputId: "main_16x9",
          outputStartSec: 40,
          outputEndSec: 41,
        },
        {
          momentId: "cm_keep",
          techniqueId: "cut_on_beat",
          outputId: "main_16x9",
          outputStartSec: 50,
          outputEndSec: 50.5,
        },
      ],
    };

    sanitizeCreativityLevelGate(recipe, { catalog });

    assert.equal(recipe.creativeMoments.length, 1);
    assert.equal(recipe.creativeMoments[0].momentId, "cm_keep");
  });

  it("drops adjacent duplicate video windows and compacts output timing", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        timeline: [
          {
            segmentId: "short_001",
            videoRef: { clipId: "clip40", sceneId: "clip40_scene001" },
            videoInSec: 0,
            videoOutSec: 5,
            outputStartSec: 0,
            outputEndSec: 5,
            subtitles: { outputStartSec: 0, outputEndSec: 5 },
          },
          {
            segmentId: "short_002",
            videoRef: { clipId: "clip40", sceneId: "clip40_scene001" },
            videoInSec: 0,
            videoOutSec: 5,
            outputStartSec: 5,
            outputEndSec: 10,
            subtitles: { outputStartSec: 5, outputEndSec: 10 },
          },
          {
            segmentId: "short_003",
            videoRef: { clipId: "clip24", sceneId: "clip24_scene001" },
            videoInSec: 0,
            videoOutSec: 8,
            outputStartSec: 10,
            outputEndSec: 18,
          },
        ],
      }],
      creativeMoments: [{
        momentId: "m1",
        outputId: "short_9x16",
        outputStartSec: 12,
        outputEndSec: 13,
      }],
    };

    sanitizeAdjacentDuplicateSegments(recipe);
    assert.equal(recipe.outputs[0].timeline.length, 2);
    assert.equal(recipe.outputs[0].timeline[0].segmentId, "short_001");
    assert.equal(recipe.outputs[0].timeline[1].segmentId, "short_003");
    assert.equal(recipe.outputs[0].timeline[1].outputStartSec, 5);
    assert.equal(recipe.outputs[0].timeline[1].outputEndSec, 13);
    assert.equal(recipe.creativeMoments[0].outputStartSec, 7);
  });

  it("sanitizeRecipeHardErrors applies both cleanups", () => {
    const recipe = {
      outputs: [{
        outputId: "main",
        timeline: [
          {
            segmentId: "a",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
            audioRef: { clipId: "clip28" },
            cuts: [{ startWordId: "clip03_w00001", endWordId: "clip03_w00002" }],
          },
          {
            segmentId: "b",
            videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
            audioRef: { clipId: "clip28" },
            cuts: [],
          },
        ],
      }],
    };

    sanitizeRecipeHardErrors(recipe);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
    assert.equal(recipe.outputs[0].timeline[1].allowBrollReuse, true);
  });

  it("reclassifies unmatched broll as aroll under match_speech_topics", () => {
    const recipe = {
      batchContext: { brollStrategy: "match_speech_topics", brollMatchThreshold: 0.55 },
      clipRegistry: [{ clipId: "clip28", clipRole: "speech" }],
      outputs: [{
        outputId: "main",
        timeline: [{
          segmentId: "b1",
          segmentRole: "broll",
          videoRef: { clipId: "clip28", sceneId: "clip28_scene001" },
        }],
      }],
    };
    const topicIndex = {
      topics: [{
        matchingScenes: [{ sceneId: "clip01_scene001", score: 0.9 }],
      }],
    };

    sanitizeUnmatchedBroll(recipe, topicIndex);
    assert.equal(recipe.outputs[0].timeline[0].segmentRole, "aroll");
  });

  it("drops whole_clip exclusion when clip is already used in timeline", () => {
    const recipe = {
      excluded: [{
        clipId: "clip01",
        exclusionType: "whole_clip",
        usableAsBroll: false,
        reason: "weak but usable as broll",
      }],
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "enrich_rewind_intro_01",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 6,
        }],
      }],
    };

    sanitizeExcludedClipUsage(recipe);
    assert.equal(recipe.excluded.length, 0);
  });

  it("drops excess music_swell / music_drop to satisfy V21-04 and V21-05", () => {
    const catalog = loadTechniqueCatalog();
    const recipe = {
      version: "2.4",
      batchId: "batch1",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      clipRegistry: [{ clipId: "clip01", durationSec: 180 }],
      outputs: [
        {
          outputId: "output_0_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: [{
            segmentId: "seg_body",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 160,
            audioInSec: 0,
            audioOutSec: 160,
            outputStartSec: 0,
            outputEndSec: 160,
            audioPolicy: "from_video_ref",
            cuts: [],
          }],
        },
        {
          outputId: "output_1_9x16",
          outputKind: "short",
          format: "9:16",
          timeline: [{
            segmentId: "short_001",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 60,
            audioInSec: 0,
            audioOutSec: 60,
            outputStartSec: 0,
            outputEndSec: 60,
            audioPolicy: "from_video_ref",
            cuts: [],
          }],
        },
      ],
      creativeMoments: [
        {
          momentId: "enrich_payoff_001",
          techniqueId: "music_drop",
          retentionRole: "payoff",
          outputId: "output_0_16x9",
          outputStartSec: 154.5,
          outputEndSec: 157.5,
          confidence: 0.9,
        },
        {
          momentId: "beat_main_001",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 48,
          outputEndSec: 51,
          confidence: 0.7,
        },
        {
          momentId: "beat_main_002",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 93,
          outputEndSec: 96,
          confidence: 0.7,
        },
        {
          momentId: "short_beat_001",
          techniqueId: "music_drop",
          retentionRole: "beat",
          outputId: "output_1_9x16",
          outputStartSec: 18,
          outputEndSec: 20,
          confidence: 0.7,
        },
        {
          momentId: "short_beat_002",
          techniqueId: "music_drop",
          retentionRole: "beat",
          outputId: "output_1_9x16",
          outputStartSec: 33,
          outputEndSec: 35,
          confidence: 0.7,
        },
      ],
      audioMixPlan: { musicBed: { trackId: "t1" } },
    };

    sanitizeCreativeMomentDensity(recipe, { catalog });

    const swells = recipe.creativeMoments.filter((m) => m.techniqueId === "music_swell");
    const shortDrops = recipe.creativeMoments.filter(
      (m) => m.techniqueId === "music_drop" && m.outputId === "output_1_9x16",
    );
    assert.ok(swells.length <= 1);
    assert.ok(shortDrops.length <= 1);
    assert.ok(recipe.creativeMoments.some((m) => m.momentId === "enrich_payoff_001"));
  });

  it("removes slow-segment beats for internet_documentary NAR hard errors", () => {
    const abstraction = {
      L2: [{
        segmentId: "seg001",
        sceneIds: ["clip01_scene001"],
        startSec: 0,
        endSec: 160,
        narrativeRole: "resolution",
      }],
    };
    const recipe = {
      version: "2.4",
      batchId: "batch1",
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "slow",
          retentionIntensity: "low",
          silencePolicy: "preserve",
        }],
      },
      outputs: [{
        outputId: "output_0_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 160,
          audioInSec: 0,
          audioOutSec: 160,
          audioPolicy: "from_video_ref",
          cuts: [],
        }],
      }],
      creativeMoments: [
        {
          momentId: "enrich_payoff_001",
          techniqueId: "music_drop",
          retentionRole: "payoff",
          outputId: "output_0_16x9",
          outputStartSec: 154.5,
          outputEndSec: 157.5,
        },
        {
          momentId: "beat_main_001",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 48,
          outputEndSec: 51,
        },
        {
          momentId: "beat_main_002",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 93,
          outputEndSec: 96,
        },
      ],
    };

    sanitizeNarrativeBeatHardErrors(recipe, { abstraction });

    assert.equal(
      recipe.creativeMoments.filter((m) => m.retentionRole === "beat").length,
      0,
    );
    assert.ok(recipe.creativeMoments.some((m) => m.momentId === "enrich_payoff_001"));
  });

  it("clears SCENE_EXCLUDED + V21 + NAR hard errors on a batch-like recipe", () => {
    const abstraction = {
      L2: [{
        segmentId: "seg001",
        sceneIds: ["clip01_scene001", "clip40_scene001"],
        startSec: 0,
        endSec: 160,
        narrativeRole: "resolution",
      }],
      L3: { openLoops: [] },
    };
    const recipe = {
      version: "2.4",
      batchId: "batch1",
      batchContext: { requiredFormats: ["16:9"] },
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "slow",
          retentionIntensity: "low",
        }],
      },
      excluded: [{
        clipId: "clip01",
        exclusionType: "whole_clip",
        usableAsBroll: false,
        reason: "weak but usable as broll",
      }],
      outputs: [{
        outputId: "output_0_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [
          {
            segmentId: "enrich_rewind_intro_01",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 6,
            audioInSec: 0,
            audioOutSec: 6,
            audioPolicy: "from_video_ref",
            cuts: [],
          },
          {
            segmentId: "seg_body",
            segmentRole: "aroll",
            videoRef: { clipId: "clip40", sceneId: "clip40_scene001" },
            audioRef: { clipId: "clip40", sceneId: "clip40_scene001" },
            videoInSec: 0,
            videoOutSec: 154,
            audioInSec: 0,
            audioOutSec: 154,
            audioPolicy: "from_video_ref",
            cuts: [],
          },
        ],
      }],
      creativeMoments: [
        {
          momentId: "enrich_payoff_001",
          techniqueId: "music_drop",
          retentionRole: "payoff",
          outputId: "output_0_16x9",
          outputStartSec: 150,
          outputEndSec: 153,
          confidence: 0.9,
          reason: "payoff",
        },
        {
          momentId: "beat_main_001",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 48,
          outputEndSec: 51,
          confidence: 0.7,
          reason: "beat",
        },
        {
          momentId: "beat_main_002",
          techniqueId: "music_swell",
          retentionRole: "beat",
          outputId: "output_0_16x9",
          outputStartSec: 93,
          outputEndSec: 96,
          confidence: 0.7,
          reason: "beat",
        },
      ],
    };

    sanitizeRecipeHardErrors(recipe, { abstraction });

    assert.equal(recipe.excluded.length, 0);
    assert.equal(
      recipe.creativeMoments.filter((m) => m.retentionRole === "beat").length,
      0,
    );
    assert.ok(recipe.creativeMoments.some((m) => m.momentId === "enrich_payoff_001"));
    assert.ok(
      recipe.creativeMoments.filter((m) => m.techniqueId === "music_swell").length <= 1,
    );
  });

  it("sanitizeZoomDutyBudget shortens over-budget camera zoom duty", () => {
    const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
    const recipe = {
      version: "2.4",
      batchContext: { requiredFormats: ["16:9"] },
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 150,
          audioInSec: 0,
          audioOutSec: 150,
          outputStartSec: 0,
          outputEndSec: 150,
          audioPolicy: "from_video_ref",
        }],
      }],
      creativeMoments: [{
        momentId: "zoom_long",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 40,
        outputEndSec: 52,
        retentionRole: "beat",
        reason: "Long zoom beat",
      }],
    };

    sanitizeZoomDutyBudget(recipe, { catalog });
    const moment = recipe.creativeMoments.find((entry) => entry.momentId === "zoom_long");
    assert.ok(moment);
    const duration = moment.outputEndSec - moment.outputStartSec;
    assert.ok(duration <= 3, `expected shortened zoom, got ${duration}s`);
  });

  it("sanitizeTechniqueMomentCap drops only decorative moments over cap", () => {
    const recipe = {
      version: "2.4",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      shortsRetentionProfile: { enabled: true },
      outputs: [
        {
          outputId: "main_16x9",
          outputKind: "main",
          format: "16:9",
          timeline: [{
            segmentId: "seg1",
            videoInSec: 0,
            videoOutSec: 120,
            outputStartSec: 0,
            outputEndSec: 120,
          }],
        },
        {
          outputId: "short_9x16",
          outputKind: "short",
          format: "9:16",
          timeline: [{
            segmentId: "short1",
            videoInSec: 0,
            videoOutSec: 60,
            outputStartSec: 0,
            outputEndSec: 60,
          }],
        },
      ],
      creativeMoments: [
        {
          momentId: "hook",
          techniqueId: "music_drop",
          outputId: "short_9x16",
          outputStartSec: 1,
          outputEndSec: 2,
          retentionRole: "hook",
          reason: "hook",
        },
        {
          momentId: "payoff",
          techniqueId: "music_drop",
          outputId: "short_9x16",
          outputStartSec: 20,
          outputEndSec: 22,
          retentionRole: "payoff",
          reason: "payoff",
        },
        {
          momentId: "decor_a",
          techniqueId: "cut_on_beat",
          outputId: "short_9x16",
          outputStartSec: 10,
          outputEndSec: 10.1,
          reason: "decor a",
        },
        {
          momentId: "decor_b",
          techniqueId: "cut_on_beat",
          outputId: "short_9x16",
          outputStartSec: 15,
          outputEndSec: 15.1,
          reason: "decor b",
        },
        {
          momentId: "decor_c",
          techniqueId: "cut_on_beat",
          outputId: "short_9x16",
          outputStartSec: 18,
          outputEndSec: 18.1,
          reason: "decor c",
        },
      ],
    };

    sanitizeTechniqueMomentCap(recipe);
    assert.ok(recipe.creativeMoments.some((m) => m.momentId === "hook"));
    assert.ok(recipe.creativeMoments.some((m) => m.momentId === "payoff"));
    assert.equal(
      recipe.creativeMoments.filter((m) => m.techniqueId === "cut_on_beat").length,
      2,
    );
  });

  it("sanitizeMissingVlogRetentionBeats inserts beats at retentionBeatTargets", () => {
    const recipe = {
      version: "2.4",
      batchContext: { requiredFormats: ["16:9"] },
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      vlogRetentionProfile: {
        enabled: true,
        retentionBeatIntervalSec: 45,
        retentionBeatToleranceSec: 8,
        minRetentionBeats: 2,
        mode: "vlog",
      },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          videoInSec: 0,
          videoOutSec: 144,
          outputStartSec: 0,
          outputEndSec: 144,
        }],
      }],
      retentionBeatTargets: [
        { outputId: "main_16x9", targetSec: 48 },
        { outputId: "main_16x9", targetSec: 93 },
        { outputId: "main_16x9", targetSec: 138 },
      ],
      creativeMoments: [{
        momentId: "beat_existing",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 46,
        outputEndSec: 47,
        retentionRole: "beat",
        reason: "existing beat",
      }],
    };

    sanitizeMissingVlogRetentionBeats(recipe);
    const beats = recipe.creativeMoments.filter((m) => m.retentionRole === "beat");
    assert.ok(beats.length >= 3);
    assert.ok(beats.some((m) => Math.abs(m.outputStartSec - 93) < 1));
    assert.ok(beats.some((m) => Math.abs(m.outputStartSec - 138) < 1));
  });

  it("sanitizeMissingVlogRetentionBeats skips resolution L2 targets", () => {
    const abstraction = {
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 100,
          sceneIds: ["clip01_scene001"],
          narrativeRole: "development",
        },
        {
          segmentId: "seg002",
          startSec: 100,
          endSec: 160,
          sceneIds: ["clip02_scene001"],
          narrativeRole: "resolution",
        },
      ],
    };
    const recipe = {
      version: "2.4",
      batchContext: { requiredFormats: ["16:9"] },
      narrativeProfile: { mode: "internet_documentary", segments: [] },
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      vlogRetentionProfile: {
        enabled: true,
        retentionBeatIntervalSec: 45,
        retentionBeatToleranceSec: 8,
        minRetentionBeats: 2,
        mode: "vlog",
      },
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [
          {
            segmentId: "seg_body",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 97,
            outputStartSec: 0,
            outputEndSec: 97,
          },
          {
            segmentId: "seg_close",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
            videoInSec: 0,
            videoOutSec: 47,
            outputStartSec: 97,
            outputEndSec: 144,
          },
        ],
      }],
      retentionBeatTargets: [
        { outputId: "main_16x9", targetSec: 48 },
        { outputId: "main_16x9", targetSec: 93 },
        { outputId: "main_16x9", targetSec: 138 },
      ],
      creativeMoments: [{
        momentId: "beat_existing",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 46,
        outputEndSec: 47,
        retentionRole: "beat",
        reason: "existing beat",
      }],
    };

    sanitizeMissingVlogRetentionBeats(recipe, { abstraction, wordIndexes: [] });
    const beats = recipe.creativeMoments.filter((m) => m.retentionRole === "beat");
    assert.ok(beats.length >= 3);
    assert.ok(beats.some((m) => Math.abs(m.outputStartSec - 93) < 1));
    assert.ok(!beats.some((m) => Math.abs(m.outputStartSec - 138) < 1));
    assert.ok(beats.some((m) => m.outputStartSec < 97));
  });

  it("sanitizeStackedPayoffAudioDucks drops silence_beat near music_drop", () => {
    const recipe = {
      creativeMoments: [
        {
          momentId: "payoff_drop",
          techniqueId: "music_drop",
          outputId: "main_16x9",
          outputStartSec: 140,
          outputEndSec: 143,
          retentionRole: "payoff",
        },
        {
          momentId: "payoff_silence",
          techniqueId: "silence_beat",
          outputId: "main_16x9",
          outputStartSec: 140.3,
          outputEndSec: 143.3,
          retentionRole: "payoff",
        },
      ],
    };

    sanitizeStackedPayoffAudioDucks(recipe);
    assert.equal(recipe.creativeMoments.length, 1);
    assert.equal(recipe.creativeMoments[0].momentId, "payoff_drop");
  });

  it("sanitizeTailSourceVolumeDb clears sourceVolumeDb below -3", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [
          { segmentId: "seg1", sourceVolumeDb: -6 },
          { segmentId: "seg2", sourceVolumeDb: 4.5 },
        ],
      }],
    };

    sanitizeTailSourceVolumeDb(recipe);
    assert.equal(recipe.outputs[0].timeline[0].sourceVolumeDb, 0);
    assert.equal(recipe.outputs[0].timeline[1].sourceVolumeDb, 4.5);
  });

  it("sanitizeSegmentSourceWindows clamps source windows to output duration", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [{
          segmentId: "seg1",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 10,
          videoOutSec: 30,
          audioInSec: 10,
          audioOutSec: 30,
          outputStartSec: 0,
          outputEndSec: 12,
          audioPolicy: "from_video_ref",
        }],
      }],
    };

    sanitizeSegmentSourceWindows(recipe);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.videoOutSec, 22);
    assert.equal(segment.audioOutSec, 22);
  });

  it("sanitizeNarrativeCtaOverlays drops summary-like enrich CTA text", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [{
          segmentId: "seg1",
          textOverlays: [{
            overlayId: "enrich_cta_001",
            text: "Vlog o restauracji i jedzeniu w mieście nagrany w…",
            outputStartSec: 350,
            outputEndSec: 360,
            role: "cta",
            style: "cta",
          }],
        }],
      }],
    };

    sanitizeNarrativeCtaOverlays(recipe);
    assert.equal(recipe.outputs[0].timeline[0].textOverlays.length, 0);
  });

  it("sanitizeNarrativeCtaOverlays drops CTA overlapping payoff overlay", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        timeline: [{
          segmentId: "seg1",
          textOverlays: [
            {
              overlayId: "payoff_overlay",
              text: "Koniec historii",
              outputStartSec: 345,
              outputEndSec: 360,
              role: "payoff",
              style: "emphasis",
            },
            {
              overlayId: "enrich_cta_001",
              text: "Subskrybuj",
              outputStartSec: 350,
              outputEndSec: 360,
              role: "cta",
              style: "cta",
            },
          ],
        }],
      }],
    };

    sanitizeNarrativeCtaOverlays(recipe);
    const overlays = recipe.outputs[0].timeline[0].textOverlays;
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].overlayId, "payoff_overlay");
  });
});
