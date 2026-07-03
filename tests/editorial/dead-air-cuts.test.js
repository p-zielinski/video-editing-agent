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
      clips: [{ clipId: "clip01", deadAirHints: [interWordHint] }],
    };

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
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
    const overlappingHint = {
      clipId: "clip01",
      startSec: 3,
      endSec: 7,
      source: "both",
      durationSec: 4,
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [overlappingHint] }],
    };

    const cutResult = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      wordIndexes: [interWordWords],
    });
    assert.equal(cutResult.appliedCuts, 0);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, {
      audioIndex,
      cutHintKeys: cutResult.cutHintKeys,
    });
    assert.ok(moments.some((moment) => moment.techniqueId === "silence_beat"));
  });

  it("silencePolicy preserve skips timeline cuts and silence_beat enrichment", () => {
    const recipe = buildMainRecipe([buildArollSegment()], {
      narrativeProfile: { silencePolicy: "preserve" },
    });
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [interWordHint] }],
    };

    const cutResult = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      wordIndexes: [interWordWords],
    });
    assert.equal(cutResult.appliedCuts, 0);

    const moments = enrichRecipeDeadAirHandling(recipe, {
      audioIndex,
      wordIndexes: [interWordWords],
    });
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });

  it("trims segment in-point when dead air is at segment start", () => {
    const recipe = buildMainRecipe([buildArollSegment({ videoInSec: 2, videoOutSec: 30 })]);
    const edgeHint = {
      clipId: "clip01",
      startSec: 0,
      endSec: 5,
      source: "both",
      durationSec: 5,
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [edgeHint] }],
    };

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      wordIndexes: [interWordWords],
    });

    assert.equal(result.appliedCuts, 1);
    const segment = recipe.outputs[0].timeline[0];
    assert.equal(segment.audioInSec, 5);
    assert.equal(segment.videoInSec, 5);
  });

  it("enrichRecipeDeadAirHandling applies cuts before silence_beat fallback", () => {
    const recipe = buildMainRecipe([buildArollSegment()]);
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [interWordHint] }],
    };

    const moments = enrichRecipeDeadAirHandling(recipe, {
      audioIndex,
      wordIndexes: [interWordWords],
    });

    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 1);
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });
});
