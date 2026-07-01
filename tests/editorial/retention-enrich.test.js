import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChapterCardHints,
  buildColdOpenSegmentHint,
  buildNarrativeOpenLoops,
  enrichRecipeChapterCards,
  enrichRecipeColdOpenSegment,
  deriveTeaseSceneIdFromRecipe,
  REWIND_INTRO_SEGMENT_ID,
  REWIND_MOMENT_ID,
  resolveChronologicalIntroRef,
} from "../../src/editorial/chapter-hints.js";
import {
  DEFAULT_VLOG_RETENTION_PROFILE,
  enrichRecipeRetentionBeats,
  resolveSpatialRefForBeat,
} from "../../src/editorial/shorts-retention.js";

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

  it("caps new beats at maxRetentionBeatMoments minus existing", () => {
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
      (m) => m.outputId === "main_16x9" && m.retentionRole === "beat",
    );
    assert.ok(enriched.length <= 13);
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

describe("chapter-hints", () => {
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
});
