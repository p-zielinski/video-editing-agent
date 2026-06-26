import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSceneRank, buildTopSceneRanks } from "./scene-rank.js";

const timelineIndex = {
  words: [
    { wordId: "clip01_w001", word: "cześć", start: 1, end: 1.4, isFiller: false },
    { wordId: "clip01_w002", word: "świat", start: 2, end: 2.4, isFiller: false },
    { wordId: "clip02_w001", word: "yyy", start: 1, end: 1.2, isFiller: true },
  ],
  scenes: [
    {
      sceneId: "clip01_scene001",
      clipId: "clip01",
      startSec: 0,
      endSec: 60,
      durationSec: 60,
      hasSpeech: true,
    },
    {
      sceneId: "clip02_scene001",
      clipId: "clip02",
      startSec: 0,
      endSec: 30,
      durationSec: 30,
      hasSpeech: false,
    },
  ],
};

const abstraction = {
  L1: [
    {
      sceneId: "clip01_scene001",
      brollPotential: 0.2,
      visualQuality: "medium",
    },
    {
      sceneId: "clip02_scene001",
      brollPotential: 0.9,
      visualQuality: "high",
    },
  ],
};

describe("scene-rank", () => {
  it("computeSceneRank returns 0-1 score favoring broll and visual quality", () => {
    const speechScene = timelineIndex.scenes[0];
    const brollScene = timelineIndex.scenes[1];

    const speechRank = computeSceneRank(
      speechScene,
      abstraction.L1[0],
      timelineIndex,
    );
    const brollRank = computeSceneRank(
      brollScene,
      abstraction.L1[1],
      timelineIndex,
      { audioTags: ["laughter"] },
    );

    assert.ok(speechRank >= 0 && speechRank <= 1);
    assert.ok(brollRank >= 0 && brollRank <= 1);
    assert.ok(brollRank > speechRank);
  });

  it("buildTopSceneRanks returns top scenes sorted by rank", () => {
    const ranks = buildTopSceneRanks(abstraction, timelineIndex, null, {
      clipRegistry: [
        { clipId: "clip02", audioTags: ["impact"] },
      ],
      limit: 10,
    });

    assert.equal(ranks.length, 2);
    assert.equal(ranks[0].sceneId, "clip02_scene001");
    assert.ok(ranks[0].rank > ranks[1].rank);
  });
});
