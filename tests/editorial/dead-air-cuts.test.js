import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipeDeadAirCuts,
  enrichRecipeSilenceBeatFromDeadAir,
  enrichRecipeDeadAirHandling,
} from "../../src/editorial/dead-air-enrich.js";

function buildMainRecipe(timeline, extra = {}) {
  return {
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      timeline,
    }],
    creativeMoments: [],
    ...extra,
  };
}

function buildArollSegment({
  segmentId = "seg1",
  clipId = "clip01",
  videoInSec = 0,
  videoOutSec = 30,
  cuts = [],
} = {}) {
  return {
    segmentId,
    segmentRole: "aroll",
    videoRef: { clipId, sceneId: `${clipId}_scene001` },
    audioRef: { clipId, sceneId: `${clipId}_scene001` },
    videoInSec,
    videoOutSec,
    audioInSec: videoInSec,
    audioOutSec: videoOutSec,
    audioPolicy: "from_video_ref",
    cuts,
  };
}

const interWordWords = {
  clipId: "clip01",
  words: [
    { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
    { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
  ],
};

const interWordHint = {
  clipId: "clip01",
  startSec: 2,
  endSec: 6,
  source: "both",
  durationSec: 4,
};

describe("dead-air-cuts", () => {
  it("enrichRecipeDeadAirCuts adds dead_air cut for high-confidence inter-word gap", () => {
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
    }];

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });

    assert.equal(result.appliedCuts, 1);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.cuts.length, 1);
    assert.equal(segment.cuts[0].reason, "dead_air");
    assert.equal(segment.cuts[0].startWordId, "clip01_w001");
    assert.equal(segment.cuts[0].endWordId, "clip01_w002");
  });

  it("mid-sentence dead air falls back to silence_beat only", () => {
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 3, endSec: 7, durationSec: 4 }],
    }];

    const cutResult = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });
    assert.equal(cutResult.appliedCuts, 0);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
      cutHintKeys: cutResult.cutHintKeys,
    });
    assert.ok(moments.some((moment) => moment.techniqueId === "silence_beat"));
  });

  it("silencePolicy preserve skips timeline cuts and silence_beat enrichment", () => {
    const recipe = buildMainRecipe([buildArollSegment()], {
      narrativeProfile: { silencePolicy: "preserve" },
    });
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
    }];

    const cutResult = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });
    assert.equal(cutResult.appliedCuts, 0);

    const moments = enrichRecipeDeadAirHandling(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });

  it("per-segment silencePolicy preserve skips only matching L2 hints", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
      ],
    };
    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
      ],
    };
    const seg001Hint = {
      clipId: "clip01",
      startSec: 2,
      endSec: 6,
      source: "both",
      durationSec: 4,
    };
    const seg002Hint = {
      clipId: "clip01",
      startSec: 122,
      endSec: 126,
      source: "both",
      durationSec: 4,
    };
    const seg002Words = {
      clipId: "clip01",
      words: [
        { wordId: "clip01_w010", word: "later", start: 120, end: 122 },
        { wordId: "clip01_w011", word: "pause", start: 126, end: 128 },
      ],
    };
    const recipe = buildMainRecipe([
      buildArollSegment({ videoInSec: 0, videoOutSec: 240 }),
    ], {
      narrativeProfile: {
        silencePolicy: "trim_dead_air",
        segments: [{ l2SegmentId: "seg002", silencePolicy: "preserve" }],
      },
    });
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [
        { startSec: 2, endSec: 6, durationSec: 4 },
        { startSec: 122, endSec: 126, durationSec: 4 },
      ],
    }];

    const cutResult = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords, seg002Words],
      abstraction,
      timelineIndex,
    });

    assert.equal(cutResult.appliedCuts, 1);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].cuts[0].startWordId, "clip01_w001");
  });

  it("trims segment in-point when dead air is at segment start", () => {
    const recipe = buildMainRecipe([buildArollSegment({ videoInSec: 2, videoOutSec: 30 })]);
    const edgeWords = {
      clipId: "clip01",
      words: [{ wordId: "clip01_w001", word: "hello", start: 5, end: 8 }],
    };
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 5, durationSec: 3 }],
    }];

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [edgeWords],
    });

    assert.equal(result.appliedCuts, 1);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.audioInSec, 5);
    assert.equal(segment.videoInSec, 5);
  });

  it("skips edge trim when new in-point would meet or exceed out-point", () => {
    const recipe = buildMainRecipe([buildArollSegment({ videoInSec: 2, videoOutSec: 5 })]);
    const edgeWords = {
      clipId: "clip01",
      words: [{ wordId: "clip01_w001", word: "hello", start: 5, end: 8 }],
    };
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 5, durationSec: 3 }],
    }];

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [edgeWords],
    });

    assert.equal(result.appliedCuts, 0);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.videoInSec, 2);
    assert.equal(segment.videoOutSec, 5);
    assert.equal(segment.cuts?.length ?? 0, 0);
  });

  it("enrichRecipeDeadAirHandling applies cuts before silence_beat fallback", () => {
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
    }];

    const moments = enrichRecipeDeadAirHandling(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });

    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });

  it("inter-word dead_air cut shifts output time for silence_beat placement", () => {
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
    }];

    enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, {
      audioIndex,
      hints: [{
        clipId: "clip01",
        startSec: 6,
        endSec: 8,
        source: "both",
        silenceKind: "dead_air",
        durationSec: 2,
      }],
      wordIndexes: [interWordWords],
      cutHintKeys: new Set(),
    });

    const beat = moments.find((moment) => moment.techniqueId === "silence_beat");
    assert.ok(beat);
    assert.equal(beat.outputStartSec, 4);
  });

  it("enrichRecipeDeadAirHandling tags hints via buildAudioIndexSummary before cuts", () => {
    const highEnergyCurve = [
      { startSec: 0, endSec: 2, rmsDb: -16 },
      { startSec: 2, endSec: 6, rmsDb: -42 },
      { startSec: 6, endSec: 8, rmsDb: -12 },
    ];
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
      batchSummary: { dominantMood: "dramatic" },
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 6, durationSec: 4 }],
      energyCurve: highEnergyCurve,
    }];

    const moments = enrichRecipeDeadAirHandling(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });

    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });
});
