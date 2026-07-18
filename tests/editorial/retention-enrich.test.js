import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChapterCardHints,
  buildColdOpenSegmentHint,
  buildNarrativeOpenLoops,
  enrichRecipeChapterCards,
  enrichRecipeColdOpenSegment,
  applyColdOpenAudioBridge,
  COLD_OPEN_SEGMENT_ID,
  deriveTeaseSceneIdFromRecipe,
  REWIND_INTRO_SEGMENT_ID,
  REWIND_MOMENT_ID,
  resolveChronologicalIntroRef,
} from "../../src/editorial/chapter-hints.js";
import {
  DEFAULT_SHORTS_RETENTION_PROFILE,
  DEFAULT_VLOG_RETENTION_PROFILE,
  enrichRecipeRetentionBeats,
  resolveBestHookScene,
  resolveEnrichBeatTechniqueId,
  resolveSpatialRefForBeat,
  SHORT_HOOK_SEGMENT_ID,
  wouldHookSpoilColdOpenLoops,
} from "../../src/editorial/shorts-retention.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";

const timelineIndex = {
  scenes: [
    {
      sceneId: "clip01_scene001",
      clipId: "clip01",
      startSec: 0,
      endSec: 90,
      durationSec: 90,
    },
    {
      sceneId: "clip01_scene002",
      clipId: "clip01",
      startSec: 90,
      endSec: 180,
      durationSec: 90,
    },
  ],
};

const spatialIndex = {
  scenes: [
    {
      sceneId: "clip01_scene001",
      clipId: "clip01",
      anchors: [
        {
          type: "face",
          bbox: [0.4, 0.2, 0.5, 0.4],
          timestampSec: 8.5,
        },
        {
          type: "subject",
          bbox: [0.35, 0.15, 0.55, 0.85],
          timestampSec: 8,
        },
      ],
    },
  ],
};

const abstraction = {
  L2: [
    {
      segmentId: "seg001",
      startSec: 0,
      endSec: 300,
      sceneIds: ["clip01_scene001"],
      summary: "Rozmowa o restauracji i jedzeniu w mieście.",
    },
    {
      segmentId: "seg002",
      startSec: 300,
      endSec: 600,
      sceneIds: ["clip01_scene002"],
      summary: "Podsumowanie wizyty — restauracja była super.",
    },
  ],
  L3: {
    sessionSummary: "Vlog o restauracji i jedzeniu w mieście.",
    narrativeArc: "intro → restauracja → podsumowanie",
  },
};

describe("enrichRecipeRetentionBeats", () => {
  const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
  const audioIndex = {
    clips: [{
      clipId: "clip01",
      energyPeaks: [
        { startSec: 39, endSec: 41, rmsDb: -12 },
        { startSec: 84, endSec: 88, rmsDb: -10 },
      ],
    }],
  };

  it("remaps unsafe enrich_beat techniques at safe creativity level", () => {
    assert.equal(resolveEnrichBeatTechniqueId("ken_burns_light", "safe"), "cut_on_beat");
    assert.equal(resolveEnrichBeatTechniqueId("music_swell", "safe"), "cut_on_beat");
    assert.equal(resolveEnrichBeatTechniqueId("zoom_slow_push", "safe"), "cut_on_beat");
    assert.equal(resolveEnrichBeatTechniqueId("ken_burns_light", "balanced"), "ken_burns_light");

    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      creativityProfile: { level: "safe" },
      vlogRetentionProfile: profile,
      creativeMoments: [{
        momentId: "enrich_beat_001",
        techniqueId: "ken_burns_light",
        outputId: "main_16x9",
        outputStartSec: 40,
        outputEndSec: 40.5,
        retentionRole: "beat",
      }],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });
    const remapped = moments.find((m) => m.momentId === "enrich_beat_001");
    assert.equal(remapped.techniqueId, "cut_on_beat");
    assert.ok(moments
      .filter((m) => m.momentId?.startsWith("enrich_beat_"))
      .every((m) => m.techniqueId === "cut_on_beat"));
  });

  it("adds enrich_beat_ moments when main lacks beats near anchors", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    assert.ok(moments.length >= 2);
    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.ok(enriched.length >= 1);
    assert.equal(enriched[0].retentionRole, "beat");
    assert.equal(enriched[0].outputId, "main_16x9");
    const beatDuration = enriched[0].outputEndSec - enriched[0].outputStartSec;
    assert.ok(beatDuration >= 0.29 && beatDuration <= 0.81);
    assert.ok(enriched[0].techniqueId);
  });

  it("skips beat enrich for L2 segments with rhythm slow or retentionIntensity low", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 240,
        timeline: [{
          segmentId: "aroll_1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 240,
          audioInSec: 0,
          audioOutSec: 240,
          audioPolicy: "from_video_ref",
        }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [
          {
            l2SegmentId: "seg001",
            rhythm: "slow",
            retentionIntensity: "low",
            silencePolicy: "preserve",
          },
          {
            l2SegmentId: "seg002",
            rhythm: "fast",
            retentionIntensity: "high",
            silencePolicy: "trim_dead_air",
          },
        ],
      },
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction,
      timelineIndex,
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    const enrichedInSlowSegment = enriched.filter((m) => m.outputStartSec < 120);
    assert.equal(enrichedInSlowSegment.length, 0);
    assert.ok(enriched.some((m) => m.outputStartSec >= 120));
  });

  it("caps enrich_beat count per L2 rhythm (normal max 1 enrich per segment)", () => {
    const singleSegmentAbstraction = {
      L2: [{
        segmentId: "seg001",
        startSec: 0,
        endSec: 600,
        sceneIds: ["clip01_scene001", "clip01_scene002"],
        summary: "Full segment",
      }],
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 600,
        timeline: [{
          segmentId: "aroll_1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 600,
          audioInSec: 0,
          audioOutSec: 600,
          audioPolicy: "from_video_ref",
        }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
      narrativeProfile: {
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "normal",
          retentionIntensity: "medium",
        }],
      },
    };

    const manyPeaksAudio = {
      clips: [{
        clipId: "clip01",
        energyPeaks: [
          { startSec: 39, endSec: 41, rmsDb: -12 },
          { startSec: 84, endSec: 88, rmsDb: -10 },
          { startSec: 129, endSec: 133, rmsDb: -10 },
          { startSec: 174, endSec: 178, rmsDb: -10 },
        ],
      }],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: manyPeaksAudio,
      abstraction: singleSegmentAbstraction,
      timelineIndex,
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.equal(enriched.length, 1);
  });

  it("preserves existing director beat moments", () => {
    const directorBeat = {
      momentId: "cm_beat_director",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 48,
      outputEndSec: 49,
      retentionRole: "beat",
      reason: "Director beat",
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [directorBeat],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    assert.ok(moments.some((m) => m.momentId === "cm_beat_director"));
  });

  it("does not duplicate beats already near anchor tolerance", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [{ outputEndSec: 60, videoInSec: 0, videoOutSec: 60 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [
        {
          momentId: "cm_beat1",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 48,
          outputEndSec: 48.5,
          retentionRole: "beat",
          reason: "Existing beat",
        },
        {
          momentId: "cm_beat2",
          techniqueId: "ken_burns_light",
          outputId: "main_16x9",
          outputStartSec: 93,
          outputEndSec: 93.5,
          retentionRole: "beat",
          reason: "Existing beat 2",
        },
      ],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: { clips: [] },
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.equal(enriched.length, 0);
  });

  it("backfills up to scaled min beats when director placed zero beats", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 600,
        timeline: [{ outputEndSec: 600, videoInSec: 0, videoOutSec: 600 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "main_16x9" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.equal(enriched.length, 13);
  });

  it("fills remaining slots when director placed some beats", () => {
    const directorBeat = {
      momentId: "cm_beat_director",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 10,
      outputEndSec: 10.5,
      retentionRole: "beat",
      reason: "Director beat",
    };
    const denseAudioIndex = {
      clips: [{
        clipId: "clip01",
        energyPeaks: Array.from({ length: 12 }, (_, i) => ({
          startSec: 48 + i * 45,
          endSec: 50 + i * 45,
          rmsDb: -12,
        })),
      }],
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 600,
        timeline: [{ outputEndSec: 600, videoInSec: 0, videoOutSec: 600 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [directorBeat],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: denseAudioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "main_16x9" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(enriched.length > 2, "expected fill beyond a small fixed cap when director placed beats");
  });

  it("skips enrich anchors within cooldown after energy peak with beat", () => {
    const clusteredPeaksAudio = {
      clips: [{
        clipId: "clip01",
        energyPeaks: [
          { startSec: 39, endSec: 41, rmsDb: -12 },
          { startSec: 44, endSec: 46, rmsDb: -11 },
          { startSec: 84, endSec: 86, rmsDb: -10 },
        ],
      }],
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [{
        momentId: "cm_beat_peak",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 40,
        outputEndSec: 40.5,
        retentionRole: "beat",
        reason: "Director beat on first peak",
      }],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: clusteredPeaksAudio,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "main_16x9" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(enriched.length >= 1);
    assert.ok(
      enriched.every((m) => m.outputStartSec < 40 || m.outputStartSec >= 50),
      "enrich beats should avoid 10s cooldown window after peak at 40s",
    );
    assert.ok(
      enriched.some((m) => Math.abs(m.outputStartSec - 85) <= 8),
      "expected enrich beat on later peak outside cooldown",
    );
  });

  it("is idempotent when enrichRecipeRetentionBeats runs twice", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
    };

    const first = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });
    recipe.creativeMoments = first;

    const second = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });
    assert.equal(second.length, first.length);
  });

  it("returns existing when vlog retention disabled", () => {
    const existing = [{
      momentId: "cm_hook",
      techniqueId: "snap_zoom",
      outputId: "main_16x9",
      outputStartSec: 0,
      outputEndSec: 2,
      retentionRole: "hook",
      reason: "Hook",
    }];
    const recipe = {
      outputs: [{ outputId: "main_16x9", outputKind: "main", format: "16:9" }],
      vlogRetentionProfile: { enabled: false },
      creativeMoments: existing,
    };

    assert.deepEqual(
      enrichRecipeRetentionBeats(recipe, { audioIndex }),
      existing,
    );
  });

  it("attaches spatialRef to enriched zoom beats when spatial index has anchors", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 180,
          audioInSec: 0,
          audioOutSec: 180,
          outputEndSec: 180,
        }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
      timelineIndex,
      spatialIndex,
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.ok(enriched.length >= 1);

    const zoomBeat = enriched.find((m) => m.techniqueId === "zoom_slow_push");
    assert.ok(zoomBeat, "expected at least one zoom_slow_push enriched beat");
    assert.ok(zoomBeat.spatialRef);
    assert.equal(zoomBeat.spatialRef.sceneId, "clip01_scene001");
    assert.equal(zoomBeat.spatialRef.clipId, "clip01");
    assert.equal(zoomBeat.spatialRef.anchorType, "face");
    assert.deepEqual(zoomBeat.spatialRef.bbox, [0.4, 0.2, 0.5, 0.4]);
  });

  it("uses center fallback spatialRef for spatial techniques when index is missing", () => {
    const mainOutput = {
      outputId: "main_16x9",
      timeline: [{
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 180,
        audioInSec: 0,
        audioOutSec: 180,
        audioPolicy: "from_video_ref",
      }],
    };

    assert.equal(
      resolveSpatialRefForBeat({
        spatialIndex,
        timelineIndex,
        outputStartSec: 40,
        mainOutput,
        techniqueId: "music_swell",
      }),
      undefined,
    );

    const fallback = resolveSpatialRefForBeat({
      timelineIndex,
      outputStartSec: 40,
      mainOutput,
      techniqueId: "zoom_slow_push",
    });
    assert.equal(fallback?.sceneId, "clip01_scene001");
    assert.equal(fallback?.timestampSec, 40);
    assert.equal(fallback?.bbox, undefined);
  });
});

const SHORTS_TECHNIQUES = new Set([
  "pattern_interrupt",
  "retention_beat",
  "snap_zoom",
  "jump_cut",
]);

describe("enrichRecipeRetentionBeats — shorts", () => {
  const shortsProfile = { ...DEFAULT_SHORTS_RETENTION_PROFILE, enabled: true };
  const audioIndex = {
    clips: [{
      clipId: "clip01",
      energyPeaks: [
        { startSec: 26, endSec: 28, rmsDb: -12 },
        { startSec: 51, endSec: 53, rmsDb: -10 },
      ],
    }],
  };

  const shortOutput = {
    outputId: "short_9x16",
    outputKind: "short",
    format: "9:16",
    targetDurationSec: 60,
    timeline: [{ outputEndSec: 60, videoInSec: 0, videoOutSec: 60 }],
  };

  it("adds enrich_beat_ moments when short lacks beats near anchors", () => {
    const recipe = {
      outputs: [shortOutput],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "short_9x16" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(enriched.length >= 1);
    assert.equal(enriched[0].retentionRole, "beat");
    assert.ok(SHORTS_TECHNIQUES.has(enriched[0].techniqueId));
    const beatDuration = enriched[0].outputEndSec - enriched[0].outputStartSec;
    assert.ok(beatDuration >= 0.29 && beatDuration <= 0.81);
  });

  it("skips pattern_interrupt enrich when segment caps disallow allowPatternInterrupt", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        format: "9:16",
        targetDurationSec: 60,
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          audioPolicy: "from_video_ref",
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      narrativeProfile: {
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "normal",
        }],
      },
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: {
        L2: [{
          segmentId: "seg001",
          startSec: 0,
          endSec: 90,
          sceneIds: ["clip01_scene001"],
        }],
      },
      timelineIndex,
    });

    const enriched = moments.filter(
      (moment) => moment.outputId === "short_9x16" && moment.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(enriched.every((moment) => moment.techniqueId !== "pattern_interrupt"));
  });

  it("does not duplicate beats already near anchor tolerance on short", () => {
    const recipe = {
      outputs: [shortOutput],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [
        {
          momentId: "cm_beat1",
          techniqueId: "pattern_interrupt",
          outputId: "short_9x16",
          outputStartSec: 28,
          outputEndSec: 28.5,
          retentionRole: "beat",
          reason: "Existing beat",
        },
        {
          momentId: "cm_beat2",
          techniqueId: "retention_beat",
          outputId: "short_9x16",
          outputStartSec: 53,
          outputEndSec: 53.5,
          retentionRole: "beat",
          reason: "Existing beat 2",
        },
      ],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: { clips: [] },
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter((m) => m.momentId.startsWith("enrich_beat_"));
    assert.equal(enriched.length, 0);
  });

  it("backfills short beats up to scaled min when director placed zero beats", () => {
    const recipe = {
      outputs: [{
        ...shortOutput,
        targetDurationSec: 180,
        timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "short_9x16" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.equal(enriched.length, 7);
  });

  it("skips short enrich anchors within cooldown after energy peak with beat", () => {
    const clusteredPeaksAudio = {
      clips: [{
        clipId: "clip01",
        energyPeaks: [
          { startSec: 26, endSec: 28, rmsDb: -12 },
          { startSec: 31, endSec: 33, rmsDb: -11 },
          { startSec: 51, endSec: 53, rmsDb: -10 },
        ],
      }],
    };
    const recipe = {
      outputs: [shortOutput],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [{
        momentId: "cm_beat_peak",
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 27,
        outputEndSec: 27.5,
        retentionRole: "beat",
        reason: "Director beat on first peak",
      }],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex: clusteredPeaksAudio,
      abstraction: { L1: [], L2: [] },
    });

    const enriched = moments.filter(
      (m) => m.outputId === "short_9x16" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(enriched.length >= 1);
    assert.ok(
      enriched.every((m) => m.outputStartSec < 27 || m.outputStartSec >= 37),
      "short enrich beats should avoid cooldown window after peak at 27s",
    );
    assert.ok(
      enriched.some((m) => Math.abs(m.outputStartSec - 52) <= 8),
      "expected short enrich beat on later peak outside cooldown",
    );
  });

  it("returns existing when shorts retention disabled", () => {
    const existing = [{
      momentId: "cm_hook",
      techniqueId: "hook_visual_punch",
      outputId: "short_9x16",
      outputStartSec: 0,
      outputEndSec: 2,
      retentionRole: "hook",
      reason: "Hook",
    }];
    const recipe = {
      outputs: [shortOutput],
      shortsRetentionProfile: { enabled: false },
      creativeMoments: existing,
    };

    assert.deepEqual(
      enrichRecipeRetentionBeats(recipe, { audioIndex }),
      existing,
    );
  });

  it("does not add enrich_hook_001 when textOverlays hook exists in window", () => {
    const recipe = {
      outputs: [{
        ...shortOutput,
        timeline: [{
          outputEndSec: 60,
          videoInSec: 0,
          videoOutSec: 60,
          textOverlays: [{
            text: "Najlepszy moment",
            outputStartSec: 0,
            outputEndSec: 2.5,
            style: "hook_large",
            role: "hook",
          }],
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    assert.equal(moments.find((m) => m.momentId === "enrich_hook_001"), undefined);
  });

  it("adds enrich_hook_001 when requireHookMoment and no hook in window", () => {
    const recipe = {
      outputs: [shortOutput],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const hook = moments.find((m) => m.momentId === "enrich_hook_001");
    assert.ok(hook);
    assert.equal(hook.outputId, "short_9x16");
    assert.equal(hook.retentionRole, "hook");
    assert.equal(hook.techniqueId, "hook_title_overlay");
    assert.equal(hook.outputStartSec, 0);
    assert.equal(hook.outputEndSec, 2.5);
    assert.ok(hook.outputStartSec < shortsProfile.hookWindowSec);
  });

  it("resolves cold_open hook scene but skips prepend when it would spoil open loop", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        format: "9:16",
        targetDurationSec: 60,
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          audioPolicy: "from_video_ref",
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const hookAbstraction = {
      L1: [
        { sceneId: "clip01_scene001", brollPotential: 0.2 },
        { sceneId: "clip01_scene002", brollPotential: 0.85 },
      ],
      L2: abstraction.L2,
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "cold_open",
          setupSceneId: "clip01_scene001",
          payoffSceneId: "clip01_scene002",
          teaseText: "Nie uwierzycie co bylo na koncu",
        }],
      },
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: hookAbstraction,
      timelineIndex,
    });

    const hook = moments.find((m) => m.momentId === "enrich_hook_001");
    assert.ok(hook);
    assert.equal(hook.techniqueId, "hook_title_overlay");
    assert.equal(hook.outputStartSec, 0);
    assert.equal(hook.outputEndSec, 2.5);
    assert.match(hook.reason, /cold_open_loop/);

    const shortTimeline = recipe.outputs[0].timeline;
    assert.equal(shortTimeline.length, 1);
    assert.equal(shortTimeline[0].segmentId, "seg_body");
    assert.equal(shortTimeline[0].videoRef.sceneId, "clip01_scene001");
  });

  it("skips hook prepend when cold_open loop would spoil but still adds hook moment", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        format: "9:16",
        targetDurationSec: 60,
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          audioPolicy: "from_video_ref",
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const hookAbstraction = {
      L1: [
        { sceneId: "clip01_scene001", brollPotential: 0.2 },
        { sceneId: "clip01_scene002", brollPotential: 0.85 },
      ],
      L2: abstraction.L2,
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "cold_open",
          setupSceneId: "clip01_scene001",
          payoffSceneId: "clip01_scene002",
          teaseText: "Spoiler guard",
        }],
      },
    };

    const { sceneId: hookSceneId } = resolveBestHookScene(hookAbstraction, timelineIndex, audioIndex);
    assert.equal(hookSceneId, "clip01_scene002");
    assert.equal(wouldHookSpoilColdOpenLoops(hookSceneId, hookAbstraction), true);

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: hookAbstraction,
      timelineIndex,
    });

    const hook = moments.find((m) => m.momentId === "enrich_hook_001");
    assert.ok(hook);
    assert.equal(hook.outputStartSec, 0);
    assert.match(hook.reason, /cold_open_loop/);

    const shortTimeline = recipe.outputs[0].timeline;
    assert.equal(shortTimeline.length, 1);
    assert.equal(shortTimeline[0].segmentId, "seg_body");
  });

  it("prepends top sceneRank hook when no openLoop and scene not at timeline start", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        format: "9:16",
        targetDurationSec: 60,
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          audioPolicy: "from_video_ref",
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const hookAbstraction = {
      L1: [
        { sceneId: "clip01_scene001", brollPotential: 0.2, keyMoments: ["intro"] },
        {
          sceneId: "clip01_scene002",
          brollPotential: 0.9,
          visualQuality: "high",
          keyMoments: ["wow"],
        },
      ],
      L2: abstraction.L2,
      L3: {},
    };

    const resolved = resolveBestHookScene(hookAbstraction, timelineIndex, audioIndex);
    assert.equal(resolved.sceneId, "clip01_scene002");
    assert.equal(resolved.source, "scene_rank");

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: hookAbstraction,
      timelineIndex,
    });

    const hook = moments.find((m) => m.momentId === "enrich_hook_001");
    assert.ok(hook);
    assert.equal(hook.outputStartSec, 0);
    assert.equal(hook.outputEndSec, 2.5);
    assert.match(hook.reason, /scene_rank/);

    assert.equal(recipe.outputs[0].timeline[0].segmentId, SHORT_HOOK_SEGMENT_ID);
    assert.equal(recipe.outputs[0].timeline[0].videoRef.sceneId, "clip01_scene002");
  });

  it("does not prepend when best hook scene already at timeline start", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        format: "9:16",
        targetDurationSec: 60,
        timeline: [{
          segmentId: "seg_hook",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 90,
          videoOutSec: 120,
          audioInSec: 90,
          audioOutSec: 120,
          audioPolicy: "from_video_ref",
        }],
      }],
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const hookAbstraction = {
      L1: [
        { sceneId: "clip01_scene001", brollPotential: 0.2 },
        { sceneId: "clip01_scene002", brollPotential: 0.9, visualQuality: "high" },
      ],
      L2: abstraction.L2,
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "cold_open",
          payoffSceneId: "clip01_scene002",
        }],
      },
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: hookAbstraction,
      timelineIndex,
    });

    const hook = moments.find((m) => m.momentId === "enrich_hook_001");
    assert.ok(hook);
    assert.equal(recipe.outputs[0].timeline.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].segmentId, "seg_hook");
    assert.match(hook.reason, /best scene/);
  });

  it("enriches both main and short outputs in dual-format recipe", () => {
    const recipe = {
      outputs: [
        {
          outputId: "main_16x9",
          outputKind: "main",
          format: "16:9",
          targetDurationSec: 180,
          timeline: [{ outputEndSec: 180, videoInSec: 0, videoOutSec: 180 }],
        },
        shortOutput,
      ],
      vlogRetentionProfile: { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true },
      shortsRetentionProfile: shortsProfile,
      creativeMoments: [],
    };

    const moments = enrichRecipeRetentionBeats(recipe, {
      audioIndex,
      abstraction: { L1: [], L2: [] },
    });

    const mainEnriched = moments.filter(
      (m) => m.outputId === "main_16x9" && m.momentId.startsWith("enrich_beat_"),
    );
    const shortEnriched = moments.filter(
      (m) => m.outputId === "short_9x16" && m.momentId.startsWith("enrich_beat_"),
    );
    assert.ok(mainEnriched.length >= 1);
    assert.ok(shortEnriched.length >= 1);
  });
});

describe("chapter-hints", () => {
  it("buildChapterCardHints places cards at L2 starts when narrativeRole present", () => {
    const narrativeAbstraction = {
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene001"],
          summary: "Rozmowa o restauracji.",
          narrativeRole: "tension",
        },
        {
          segmentId: "seg002",
          startSec: 300,
          endSec: 600,
          sceneIds: ["clip01_scene002"],
          summary: "Oddech — cisza.",
          narrativeRole: "breath",
        },
        {
          segmentId: "seg003",
          startSec: 600,
          endSec: 720,
          sceneIds: ["clip01_scene002"],
          summary: "Podsumowanie wizyty.",
          narrativeRole: "payoff",
        },
      ],
    };

    const hints = buildChapterCardHints(narrativeAbstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
    });

    assert.equal(hints.length, 2);
    assert.equal(hints[0].targetSec, 0);
    assert.equal(hints[0].l2SegmentId, "seg001");
    assert.equal(hints[1].targetSec, 600);
    assert.equal(hints[1].l2SegmentId, "seg003");
  });

  it("buildChapterCardHints skips slow rhythm segments in narrativeProfile", () => {
    const narrativeAbstraction = {
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 300,
          summary: "Setup.",
          narrativeRole: "tension",
        },
        {
          segmentId: "seg002",
          startSec: 300,
          endSec: 600,
          summary: "Slow beat.",
          narrativeRole: "resolution",
        },
        {
          segmentId: "seg003",
          startSec: 600,
          endSec: 720,
          summary: "Payoff.",
          narrativeRole: "payoff",
        },
      ],
    };

    const hints = buildChapterCardHints(narrativeAbstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
      narrativeProfile: {
        segments: [
          { l2SegmentId: "seg001", rhythm: "fast" },
          { l2SegmentId: "seg002", rhythm: "slow" },
          { l2SegmentId: "seg003", rhythm: "normal" },
        ],
      },
    });

    assert.equal(hints.length, 2);
    assert.deepEqual(
      hints.map((hint) => hint.l2SegmentId),
      ["seg001", "seg003"],
    );
  });

  it("buildChapterCardHints suggests cards every ~3-5 min on main", () => {
    const hints = buildChapterCardHints(abstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
    });

    assert.ok(hints.length >= 2);
    assert.equal(hints[0].style, "chapter_card");
    assert.ok(hints[0].suggestedText);
    assert.ok(hints[0].targetSec >= 180);
  });

  it("buildChapterCardHints empty for short main", () => {
    const hints = buildChapterCardHints(abstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 120,
      }],
    });
    assert.equal(hints.length, 0);
  });

  it("buildNarrativeOpenLoops returns cold open and payoff tease", () => {
    const loops = buildNarrativeOpenLoops(abstraction);
    assert.equal(loops.length, 2);
    assert.equal(loops[0].type, "cold_open");
    assert.match(loops[0].hint, /podsumowanie/);
    assert.equal(loops[1].type, "payoff_tease");
    assert.match(loops[1].hint, /restauracji/);
  });

  it("buildColdOpenSegmentHint suggests payoff tease scene for cold open", () => {
    const hint = buildColdOpenSegmentHint(abstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
    });

    assert.equal(hint?.type, "cold_open");
    assert.equal(hint?.suggestedSceneId, "clip01_scene002");
    assert.equal(hint?.suggestedVideoRef?.clipId, "clip01");
    assert.match(hint?.suggestion ?? "", /cold open/);
  });

  it("enrichRecipeColdOpenSegment prepends cold open and rewind intro on main timeline", () => {
    const hint = buildColdOpenSegmentHint(abstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
    }, {
      clipRegistry: [
        { clipId: "clip01", sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true },
      ],
      timelineIndex,
    });

    const recipe = {
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
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
        }],
      }],
      creativeMoments: [],
      sfxPlan: [],
    };

    enrichRecipeColdOpenSegment(recipe, hint, timelineIndex);
    assert.equal(recipe.outputs[0].timeline[0].segmentId, "enrich_cold_open_01");
    assert.equal(recipe.outputs[0].timeline[0].videoRef.sceneId, "clip01_scene002");
    assert.equal(recipe.outputs[0].timeline[1].segmentId, "seg_body");
    assert.equal(recipe.outputs[0].timeline[1].videoRef.sceneId, "clip01_scene001");
    assert.ok(recipe.creativeMoments.some((moment) => moment.momentId === REWIND_MOMENT_ID));
  });

  it("applyColdOpenAudioBridge sets from_prev overlap on rewind intro", () => {
    const mainOutput = {
      timeline: [
        { segmentId: COLD_OPEN_SEGMENT_ID, audioPolicy: "from_video_ref", overlapSec: 0 },
        { segmentId: REWIND_INTRO_SEGMENT_ID, audioPolicy: "from_video_ref", overlapSec: 0 },
        { segmentId: "seg_body" },
      ],
    };

    assert.equal(applyColdOpenAudioBridge(mainOutput), true);
    assert.equal(mainOutput.timeline[1].audioPolicy, "from_prev");
    assert.equal(mainOutput.timeline[1].overlapSec, 0.4);
  });

  it("deriveTeaseSceneIdFromRecipe returns cold open scene for chronology exempt", () => {
    const recipe = {
      outputs: [{
        outputKind: "main",
        timeline: [{
          segmentId: "enrich_cold_open_01",
          videoRef: { sceneId: "clip01_scene002" },
        }],
      }],
    };
    assert.equal(deriveTeaseSceneIdFromRecipe(recipe), "clip01_scene002");
    assert.equal(deriveTeaseSceneIdFromRecipe({ outputs: [{ outputKind: "main", timeline: [] }] }), null);
  });

  it("deriveTeaseSceneIdFromRecipe detects director-only cold open tease with rewind intro", () => {
    const recipe = {
      clipRegistry: [
        { clipId: "clip01", sortIndex: 0 },
        { clipId: "clip02", sortIndex: 1 },
      ],
      outputs: [{
        outputKind: "main",
        timeline: [
          {
            segmentId: "dir_cold_open",
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene002" },
          },
          {
            segmentId: REWIND_INTRO_SEGMENT_ID,
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          },
          {
            segmentId: "seg_intro",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          },
        ],
      }],
    };
    assert.equal(deriveTeaseSceneIdFromRecipe(recipe), "clip02_scene002");
  });

  it("deriveTeaseSceneIdFromRecipe returns null for inverted chronology without rewind", () => {
    const recipe = {
      clipRegistry: [
        { clipId: "clip01", sortIndex: 0 },
        { clipId: "clip02", sortIndex: 1 },
      ],
      outputs: [{
        outputKind: "main",
        timeline: [
          {
            segmentId: "s1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
          },
          {
            segmentId: "s2",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          },
        ],
      }],
    };
    assert.equal(deriveTeaseSceneIdFromRecipe(recipe), null);
  });

  it("resolveChronologicalIntroRef picks lowest sortIndex speech clip", () => {
    const ref = resolveChronologicalIntroRef(
      [
        { clipId: "clip02", sortIndex: 1, clipRole: "broll_pool", hasSpeech: false },
        { clipId: "clip01", sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true },
      ],
      timelineIndex,
    );
    assert.equal(ref?.sceneId, "clip01_scene001");
  });

  it("enrichRecipeChapterCards adds chapter_card overlays on long main", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
        timeline: [
          {
            segmentId: "seg1",
            segmentRole: "aroll",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 720,
            audioInSec: 0,
            audioOutSec: 720,
            audioPolicy: "from_video_ref",
            textOverlays: [],
          },
        ],
      }],
    };

    enrichRecipeChapterCards(recipe, { abstraction });
    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    const chapterCards = overlays.filter((overlay) => overlay.style === "chapter_card");
    assert.ok(chapterCards.length >= 1);
    assert.ok(chapterCards[0].text);
  });
});

describe("enrichRecipeChapterCards", () => {
  const longMainRecipe = () => ({
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      targetDurationSec: 720,
      timeline: [
        {
          segmentId: "seg_m1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 360,
          audioInSec: 0,
          audioOutSec: 360,
          audioPolicy: "from_video_ref",
          textOverlays: [],
        },
        {
          segmentId: "seg_m2",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 360,
          videoOutSec: 720,
          audioInSec: 360,
          audioOutSec: 720,
          audioPolicy: "from_video_ref",
          textOverlays: [],
        },
      ],
    }],
  });

  it("places chapter cards at L2 output starts when narrativeRole present", () => {
    const narrativeAbstraction = {
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene001"],
          summary: "Rozmowa o restauracji.",
          narrativeRole: "tension",
        },
        {
          segmentId: "seg002",
          startSec: 300,
          endSec: 600,
          sceneIds: ["clip01_scene002"],
          summary: "Oddech.",
          narrativeRole: "breath",
        },
        {
          segmentId: "seg003",
          startSec: 600,
          endSec: 720,
          sceneIds: ["clip01_scene002"],
          summary: "Podsumowanie wizyty.",
          narrativeRole: "payoff",
        },
      ],
    };
    const recipe = longMainRecipe();
    enrichRecipeChapterCards(recipe, { abstraction: narrativeAbstraction });

    const chapterCards = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? [])
      .filter((o) => o.style === "chapter_card");
    assert.equal(chapterCards.length, 2);
    assert.equal(chapterCards[0].outputStartSec, 0);
    assert.equal(chapterCards[1].outputStartSec, 600);
  });

  it("adds chapter_card overlays on long main when none exist", () => {
    const recipe = longMainRecipe();
    enrichRecipeChapterCards(recipe, { abstraction });

    const main = recipe.outputs[0];
    const overlays = main.timeline.flatMap((seg) => seg.textOverlays ?? []);
    const chapterCards = overlays.filter((o) => o.style === "chapter_card");
    assert.ok(chapterCards.length >= 1);
    assert.equal(chapterCards[0].role, "chapter");
    assert.ok(chapterCards[0].text);
    assert.equal(chapterCards[0].outputStartSec, 240);
    assert.equal(chapterCards[0].outputEndSec, 244);
  });

  it("skips enrichment for short main under 180s", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 120,
        timeline: [{
          segmentId: "seg_s",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01" },
          audioRef: { clipId: "clip01" },
          videoInSec: 0,
          videoOutSec: 120,
          audioInSec: 0,
          audioOutSec: 120,
          audioPolicy: "from_video_ref",
          textOverlays: [],
        }],
      }],
    };

    enrichRecipeChapterCards(recipe, { abstraction });
    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(overlays.length, 0);
  });

  it("preserves existing director chapter_card near target", () => {
    const recipe = longMainRecipe();
    recipe.outputs[0].timeline[0].textOverlays = [{
      text: "Director chapter",
      outputStartSec: 238,
      outputEndSec: 242,
      style: "chapter_card",
      role: "chapter",
    }];

    enrichRecipeChapterCards(recipe, { abstraction });
    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    const near240 = overlays.filter(
      (o) => o.style === "chapter_card" && Math.abs(o.outputStartSec - 240) <= 15,
    );
    assert.equal(near240.length, 1);
    assert.equal(near240[0].text, "Director chapter");
  });

  it("is idempotent when enrichRecipeChapterCards runs twice", () => {
    const recipe = longMainRecipe();
    enrichRecipeChapterCards(recipe, { abstraction });
    const countAfterFirst = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []).length;

    enrichRecipeChapterCards(recipe, { abstraction });
    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(overlays.length, countAfterFirst);
    const chapterCards = overlays.filter((o) => o.style === "chapter_card");
    assert.ok(chapterCards.every((o) => o.overlayId?.startsWith("enrich_chapter_")));
  });

  it("skips chapter cards for breath and slow L2 segments", () => {
    const narrativeAbstraction = {
      L2: [
        {
          segmentId: "seg001",
          startSec: 0,
          endSec: 300,
          summary: "Setup.",
          narrativeRole: "tension",
        },
        {
          segmentId: "seg002",
          startSec: 300,
          endSec: 600,
          summary: "Breath pause.",
          narrativeRole: "breath",
        },
        {
          segmentId: "seg003",
          startSec: 600,
          endSec: 720,
          summary: "Payoff.",
          narrativeRole: "payoff",
        },
      ],
    };
    const recipe = {
      ...longMainRecipe(),
      narrativeProfile: {
        segments: [
          { l2SegmentId: "seg001", rhythm: "fast", retentionIntensity: "high" },
          { l2SegmentId: "seg002", rhythm: "slow", retentionIntensity: "low" },
          { l2SegmentId: "seg003", rhythm: "normal", retentionIntensity: "medium" },
        ],
      },
    };

    enrichRecipeChapterCards(recipe, { abstraction: narrativeAbstraction });

    const chapterCards = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? [])
      .filter((o) => o.style === "chapter_card");
    assert.equal(chapterCards.length, 2);
    assert.ok(chapterCards.every((o) => o.outputStartSec === 0 || o.outputStartSec === 600));
  });
});

describe("applyDeterministicRecipeEnrichers integration", () => {
  const profile = { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true };
  const audioIndex = {
    clips: [{
      clipId: "clip01",
      energyPeaks: [
        { startSec: 39, endSec: 41, rmsDb: -12 },
        { startSec: 84, endSec: 88, rmsDb: -10 },
      ],
    }],
  };
  const clipRegistry = [
    {
      clipId: "clip01",
      fileName: "a.mov",
      durationSec: 180,
      sortIndex: 0,
      clipRole: "aroll_primary",
      hasSpeech: true,
    },
  ];

  const enrichContext = {
    abstraction,
    timelineIndex,
    spatialIndex,
    audioIndex,
    clipRegistry,
    batchContext: { brollStrategy: "minimal" },
  };

  it("keeps stable creativeMoments count when called twice", () => {
    const recipe = {
      version: "2.4",
      batchId: "enrich01",
      batchContext: {
        requiredFormats: ["16:9"],
        brollStrategy: "minimal",
      },
      clipRegistry,
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 180,
        timeline: [{
          segmentId: "seg_body",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 180,
          audioInSec: 0,
          audioOutSec: 180,
          audioPolicy: "from_video_ref",
        }],
      }],
      vlogRetentionProfile: profile,
      creativeMoments: [],
      sfxPlan: [],
    };

    applyDeterministicRecipeEnrichers(recipe, enrichContext);
    const countAfterFirst = recipe.creativeMoments?.length ?? 0;
    assert.ok(countAfterFirst > 0, "expected enrichers to add creativeMoments");

    const timelineAfterFirst = recipe.outputs[0].timeline;
    const segmentCountAfterFirst = timelineAfterFirst.length;
    const firstSegmentSnapshot = timelineAfterFirst.map((seg) => ({
      videoInSec: seg.videoInSec,
      videoOutSec: seg.videoOutSec,
      cutsLength: seg.cuts?.length ?? 0,
    }));

    applyDeterministicRecipeEnrichers(recipe, enrichContext);
    const countAfterSecond = recipe.creativeMoments?.length ?? 0;
    assert.equal(countAfterSecond, countAfterFirst);

    const timelineAfterSecond = recipe.outputs[0].timeline;
    assert.equal(timelineAfterSecond.length, segmentCountAfterFirst);
    for (let i = 0; i < timelineAfterSecond.length; i += 1) {
      assert.equal(timelineAfterSecond[i].videoInSec, firstSegmentSnapshot[i].videoInSec);
      assert.equal(timelineAfterSecond[i].videoOutSec, firstSegmentSnapshot[i].videoOutSec);
      assert.equal(timelineAfterSecond[i].cuts?.length ?? 0, firstSegmentSnapshot[i].cutsLength);
    }
  });
});
