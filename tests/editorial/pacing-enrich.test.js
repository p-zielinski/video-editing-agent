import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipePacingTrim,
  isOverPacingBudget,
  isProtectedPacingSegment,
  MAX_SEGMENT_REMOVALS,
  MIN_KEEP_RATIO,
  PACING_TOLERANCE,
  resolvePacingBudgetSec,
} from "../../src/editorial/pacing-enrich.js";
import { COLD_OPEN_SEGMENT_ID } from "../../src/editorial/chapter-hints.js";
import { validateNarrativePacingTrimExhausted } from "../../src/validators/narrative.js";
import { buildOutputTimeline } from "../../src/lib/build-output-timeline.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 100, hasSpeech: true },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 100, endSec: 200, hasSpeech: true },
    { sceneId: "clip01_scene003", clipId: "clip01", startSec: 200, endSec: 300, hasSpeech: false },
    { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 60, hasSpeech: false },
    { sceneId: "clip02_scene002", clipId: "clip02", startSec: 60, endSec: 120, hasSpeech: false },
  ],
};

const abstraction = {
  L2: [
    {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001"],
      startSec: 0,
      endSec: 100,
      narrativeRole: "development",
    },
    {
      segmentId: "seg002",
      sceneIds: ["clip01_scene002"],
      startSec: 100,
      endSec: 200,
      narrativeRole: "climax",
    },
    {
      segmentId: "seg003",
      sceneIds: ["clip01_scene003"],
      startSec: 200,
      endSec: 300,
      narrativeRole: "breath",
    },
  ],
  L3: {
    estimatedKeepRatio: 0.35,
    openLoops: [{
      loopId: "loop_01",
      kind: "cold_open",
      setupSceneId: "clip01_scene001",
      payoffSceneId: "clip01_scene002",
    }],
  },
};

function buildArollSegment({
  segmentId,
  sceneId,
  clipId = "clip01",
  videoInSec = 0,
  videoOutSec = 100,
  segmentRole = "aroll",
  retentionRole,
} = {}) {
  return {
    segmentId,
    segmentRole,
    retentionRole,
    videoRef: { clipId, sceneId },
    audioRef: { clipId, sceneId },
    videoInSec,
    videoOutSec,
    audioInSec: videoInSec,
    audioOutSec: videoOutSec,
    audioPolicy: segmentRole === "broll" ? "from_audio_ref" : "from_video_ref",
    cuts: [],
  };
}

function buildOverBudgetRecipe() {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"] },
    clipRegistry: [
      { clipId: "clip01", durationSec: 300 },
      { clipId: "clip02", durationSec: 120 },
    ],
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [
        buildArollSegment({
          segmentId: "seg_main",
          sceneId: "clip01_scene001",
          videoOutSec: 300,
        }),
        buildArollSegment({
          segmentId: "seg_broll_edge",
          sceneId: "clip02_scene001",
          clipId: "clip02",
          segmentRole: "broll",
          videoOutSec: 60,
        }),
        buildArollSegment({
          segmentId: "seg_broll_edge_2",
          sceneId: "clip02_scene002",
          clipId: "clip02",
          segmentRole: "broll",
          videoInSec: 60,
          videoOutSec: 120,
        }),
      ],
    }],
    creativeMoments: [],
  };
}

function mainDuration(recipe, wordIndexes = null) {
  const mainOutput = recipe.outputs[0];
  const enriched = buildOutputTimeline(mainOutput, { wordIndexes });
  return enriched.at(-1)?.outputEndSec ?? 0;
}

describe("pacing-enrich", () => {
  it("resolvePacingBudgetSec uses max(estimatedKeepRatio, 0.35) * 1.05", () => {
    const recipe = { clipRegistry: [{ clipId: "clip01", durationSec: 100 }] };
    assert.equal(resolvePacingBudgetSec(recipe, 0.2), 100 * MIN_KEEP_RATIO * PACING_TOLERANCE);
    assert.equal(resolvePacingBudgetSec(recipe, 0.5), 100 * 0.5 * PACING_TOLERANCE);
  });

  it("does not trim when estimatedKeepRatio is absent from L3", () => {
    const recipe = {
      clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [buildArollSegment({
          segmentId: "seg_main",
          sceneId: "clip01_scene001",
          videoOutSec: 360,
        })],
      }],
    };

    enrichRecipePacingTrim(recipe, {
      abstraction: { L2: [], L3: {} },
      timelineIndex,
    });

    assert.equal(recipe.outputs[0].timeline.length, 1);
    assert.equal(recipe.pacingTrimMeta?.applied, true);
    assert.equal(recipe.pacingTrimMeta?.segmentsRemoved ?? 0, 0);
  });

  it("does not trim when main output is within pacing budget", () => {
    const recipe = {
      clipRegistry: [{ clipId: "clip01", durationSec: 300 }],
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [buildArollSegment({
          segmentId: "seg_main",
          sceneId: "clip01_scene001",
          videoOutSec: 100,
        })],
      }],
    };

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.equal(recipe.outputs[0].timeline.length, 1);
    assert.equal(recipe.pacingTrimMeta?.segmentsRemoved ?? 0, 0);
  });

  it("removes low-value edge broll when over V24-05 budget", () => {
    const recipe = buildOverBudgetRecipe();
    assert.ok(isOverPacingBudget(recipe, { estimatedKeepRatio: 0.35 }));

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.ok(recipe.pacingTrimMeta.segmentsRemoved >= 1);
    assert.ok(recipe.outputs[0].timeline.length < 3);
    assert.ok(!recipe.outputs[0].timeline.some((segment) => segment.segmentId === "seg_broll_edge_2"));
  });

  it("never removes cold open tease segment", () => {
    const recipe = buildOverBudgetRecipe();
    recipe.outputs[0].timeline.unshift({
      ...buildArollSegment({
        segmentId: COLD_OPEN_SEGMENT_ID,
        sceneId: "clip01_scene001",
        videoOutSec: 8,
      }),
    });

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.equal(recipe.outputs[0].timeline[0].segmentId, COLD_OPEN_SEGMENT_ID);
  });

  it("never removes payoff/climax scene segment", () => {
    const recipe = buildOverBudgetRecipe();
    recipe.outputs[0].timeline = [
      buildArollSegment({
        segmentId: "seg_climax",
        sceneId: "clip01_scene002",
        videoOutSec: 300,
      }),
      ...recipe.outputs[0].timeline.slice(1),
    ];

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.ok(recipe.outputs[0].timeline.some((segment) => segment.sceneId === "clip01_scene002"
      || segment.videoRef?.sceneId === "clip01_scene002"));
  });

  it("never removes segments with retentionRole payoff/breath/closure", () => {
    const recipe = buildOverBudgetRecipe();
    recipe.outputs[0].timeline.push(buildArollSegment({
      segmentId: "seg_closure",
      sceneId: "clip02_scene002",
      clipId: "clip02",
      segmentRole: "broll",
      retentionRole: "closure",
      videoOutSec: 30,
    }));

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.ok(recipe.outputs[0].timeline.some((segment) => segment.segmentId === "seg_closure"));
  });

  it("is idempotent on second run after exhausting removals", () => {
    const recipe = buildOverBudgetRecipe();
    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    const afterFirst = {
      timelineLength: recipe.outputs[0].timeline.length,
      segmentsRemoved: recipe.pacingTrimMeta.segmentsRemoved,
      duration: mainDuration(recipe),
    };

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
    });

    assert.equal(recipe.outputs[0].timeline.length, afterFirst.timelineLength);
    assert.equal(recipe.pacingTrimMeta.segmentsRemoved, afterFirst.segmentsRemoved);
    assert.equal(mainDuration(recipe), afterFirst.duration);
  });

  it("caps segment removals at maxSegmentRemovals", () => {
    const recipe = buildOverBudgetRecipe();
    for (let index = 0; index < 5; index += 1) {
      recipe.outputs[0].timeline.push(buildArollSegment({
        segmentId: `seg_extra_broll_${index}`,
        sceneId: "clip02_scene001",
        clipId: "clip02",
        segmentRole: "broll",
        videoOutSec: 30,
      }));
    }

    enrichRecipePacingTrim(recipe, {
      abstraction,
      timelineIndex,
      estimatedKeepRatio: 0.35,
      maxSegmentRemovals: MAX_SEGMENT_REMOVALS,
    });

    assert.equal(recipe.pacingTrimMeta.segmentsRemoved, MAX_SEGMENT_REMOVALS);
    assert.equal(recipe.pacingTrimMeta.exhausted, true);
  });

  it("applies dead air cuts before dropping whole segments", () => {
    const words = {
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 8, end: 10 },
      ],
    };
    const recipe = {
      clipRegistry: [{ clipId: "clip01", durationSec: 100 }],
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [buildArollSegment({
          segmentId: "seg_main",
          sceneId: "clip01_scene001",
          videoOutSec: 40,
        })],
      }],
    };

    enrichRecipePacingTrim(recipe, {
      abstraction: { L3: { estimatedKeepRatio: 0.35 }, L2: [] },
      timelineIndex,
      estimatedKeepRatio: 0.35,
      audioIndex: { clips: [{ clipId: "clip01" }] },
      perClipAnalysis: [{
        clipId: "clip01",
        silenceGaps: [{ startSec: 2, endSec: 8, durationSec: 6 }],
      }],
      wordIndexes: [words],
    });

    const segment = recipe.outputs[0].timeline[0];
    assert.ok(segment);
    assert.equal(segment.cuts?.length ?? 0, 1);
    assert.equal(segment.cuts[0].reason, "dead_air");
    assert.equal(recipe.pacingTrimMeta?.segmentsRemoved ?? 0, 0);
    assert.ok((recipe.pacingTrimMeta?.deadAirCuts ?? 0) >= 1);
  });
});

describe("validateNarrativePacingTrimExhausted", () => {
  it("emits NAR-PACING-TRIM-EXHAUSTED when trim exhausted and still over budget", () => {
    const recipe = buildOverBudgetRecipe();
    recipe.pacingTrimMeta = {
      segmentsRemoved: MAX_SEGMENT_REMOVALS,
      deadAirCuts: 0,
      edgeTrims: 0,
      exhausted: true,
    };

    const issues = validateNarrativePacingTrimExhausted(recipe, {
      abstraction,
      estimatedKeepRatio: 0.35,
    });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PACING-TRIM-EXHAUSTED");
  });

  it("passes when pacing trim brought output within budget", () => {
    const recipe = {
      clipRegistry: [{ clipId: "clip01", durationSec: 300 }],
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [buildArollSegment({
          segmentId: "seg_main",
          sceneId: "clip01_scene001",
          videoOutSec: 100,
        })],
      }],
      pacingTrimMeta: { segmentsRemoved: 2, exhausted: false },
    };

    const issues = validateNarrativePacingTrimExhausted(recipe, {
      abstraction,
      estimatedKeepRatio: 0.35,
    });
    assert.equal(issues.length, 0);
  });
});

describe("isProtectedPacingSegment", () => {
  it("marks breath L2 span as protected", () => {
    const segment = buildArollSegment({
      segmentId: "seg_breath",
      sceneId: "clip01_scene003",
      videoInSec: 200,
      videoOutSec: 300,
    });
    const recipe = { outputs: [{ outputKind: "main", outputId: "main_16x9" }], creativeMoments: [] };
    const enriched = [{ ...segment, outputStartSec: 0, outputEndSec: 100 }];

    assert.equal(
      isProtectedPacingSegment(segment, 1, recipe, abstraction, timelineIndex, null),
      true,
    );
    assert.equal(enriched.length, 1);
  });
});
