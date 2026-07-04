import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySilenceKind,
  tagDeadAirHintsWithSilenceKind,
  buildAudioIndexSummary,
} from "../../src/editorial/audio-index-summary.js";
import { buildDeadAirMontageHints } from "../../src/editorial/editorial-context.js";
import {
  enrichRecipeDeadAirCuts,
  enrichRecipeSilenceBeatFromDeadAir,
} from "../../src/editorial/dead-air-enrich.js";

const highEnergyCurve = [
  { startSec: 0, endSec: 2, rmsDb: -16 },
  { startSec: 2, endSec: 4, rmsDb: -15 },
  { startSec: 4, endSec: 6, rmsDb: -14 },
  { startSec: 6, endSec: 8, rmsDb: -42 },
  { startSec: 8, endSec: 10, rmsDb: -12 },
];

const monotoneCurve = [
  { startSec: 0, endSec: 3, rmsDb: -28 },
  { startSec: 3, endSec: 6, rmsDb: -27 },
  { startSec: 6, endSec: 9, rmsDb: -29 },
  { startSec: 9, endSec: 12, rmsDb: -28 },
];

const breathCurve = [
  { startSec: 0, endSec: 2, rmsDb: -22 },
  { startSec: 2, endSec: 2.8, rmsDb: -45 },
  { startSec: 2.8, endSec: 4, rmsDb: -14 },
];

const interWordWords = {
  clipId: "clip01",
  words: [
    { wordId: "clip01_w001", word: "setup", start: 0, end: 2 },
    { wordId: "clip01_w002", word: "punchline", start: 2.8, end: 4 },
  ],
};

describe("silence taxonomy", () => {
  it("classifies long silence after high energy as dramatic_pause", () => {
    const kind = classifySilenceKind(
      { startSec: 4, endSec: 7.5 },
      { energyCurve: highEnergyCurve, wordIndex: interWordWords },
    );
    assert.equal(kind, "dramatic_pause");
  });

  it("classifies short low-RMS gap before punchline word as breath_before_punchline", () => {
    const kind = classifySilenceKind(
      { startSec: 2, endSec: 2.8 },
      { energyCurve: breathCurve, wordIndex: interWordWords },
    );
    assert.equal(kind, "breath_before_punchline");
  });

  it("classifies isolated silence in monotone speech as dead_air", () => {
    const monotoneWords = {
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "um", start: 0, end: 1 },
        { wordId: "clip01_w002", word: "like", start: 4, end: 5 },
        { wordId: "clip01_w003", word: "yeah", start: 9, end: 10 },
      ],
    };
    const kind = classifySilenceKind(
      { startSec: 5, endSec: 6.2 },
      { energyCurve: monotoneCurve, wordIndex: monotoneWords },
    );
    assert.equal(kind, "dead_air");
  });

  it("narrativeProfile preserve biases toward dramatic_pause over dead_air", () => {
    const kind = classifySilenceKind(
      { startSec: 5, endSec: 6.2 },
      {
        energyCurve: monotoneCurve,
        wordIndex: interWordWords,
        narrativeProfile: { silencePolicy: "preserve" },
      },
    );
    assert.equal(kind, "dramatic_pause");
  });

  it("tagDeadAirHintsWithSilenceKind adds silenceKind to fused hints", () => {
    const hints = tagDeadAirHintsWithSilenceKind(
      [{ startSec: 4, endSec: 7.5, source: "both" }],
      { energyCurve: highEnergyCurve, wordIndex: interWordWords },
    );
    assert.equal(hints[0].silenceKind, "dramatic_pause");
  });

  it("buildAudioIndexSummary tags deadAirHints with silenceKind", () => {
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
      batchSummary: { dominantMood: "dramatic" },
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 4, endSec: 7.5, durationSec: 3.5 }],
      energyCurve: highEnergyCurve,
    }];
    const wordIndexes = [interWordWords];

    const summary = buildAudioIndexSummary(audioIndex, { perClipAnalysis, wordIndexes });
    const hint = summary.clips[0].deadAirHints.find((h) => h.startSec === 4);
    assert.equal(hint.silenceKind, "dramatic_pause");
  });

  it("buildDeadAirMontageHints only emits cut-eligible dead_air hints", () => {
    const audioSummary = {
      clips: [{
        clipId: "clip01",
        deadAirHints: [
          { startSec: 2, endSec: 6, source: "both", silenceKind: "dead_air" },
          { startSec: 4, endSec: 7.5, source: "both", silenceKind: "dramatic_pause" },
          { startSec: 2, endSec: 2.8, source: "both", silenceKind: "breath_before_punchline" },
          { startSec: 10, endSec: 12, source: "both" },
        ],
      }],
    };

    const hints = buildDeadAirMontageHints(audioSummary);
    assert.equal(hints.length, 2);
    assert.ok(hints.every((h) => h.silenceKind === "dead_air" || h.silenceKind == null));
    assert.ok(hints.every((h) => h.silenceKind != null || h.source === "both"));
  });

  it("enrichRecipeDeadAirCuts skips dramatic_pause and breath_before_punchline", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
          cuts: [],
        }],
      }],
    };
    const deadAirHint = {
      clipId: "clip01",
      startSec: 2,
      endSec: 6,
      source: "both",
      durationSec: 4,
      silenceKind: "dramatic_pause",
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [deadAirHint] }],
    };

    const result = enrichRecipeDeadAirCuts(recipe, {
      audioIndex,
      hints: buildDeadAirMontageHints(audioIndex),
      wordIndexes: [{
        clipId: "clip01",
        words: [
          { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
          { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
        ],
      }],
    });

    assert.equal(result.appliedCuts, 0);
    assert.equal(recipe.outputs[0].timeline[0].cuts.length, 0);
  });

  it("enrichRecipeSilenceBeatFromDeadAir adds dip for breath_before_punchline when not preserve", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
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
    };
    const breathCurve = [
      { startSec: 0, endSec: 2, rmsDb: -22 },
      { startSec: 2, endSec: 2.8, rmsDb: -45 },
      { startSec: 2.8, endSec: 4, rmsDb: -14 },
    ];
    const audioIndex = {
      clips: [{ clipId: "clip01" }],
    };
    const perClipAnalysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 2, endSec: 2.8, durationSec: 0.8 }],
      energyCurve: breathCurve,
    }];

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, {
      audioIndex,
      perClipAnalysis,
      wordIndexes: [interWordWords],
    });
    assert.ok(moments.some((m) => m.techniqueId === "silence_beat"));
    assert.match(
      moments.find((m) => m.techniqueId === "silence_beat")?.reason ?? "",
      /breath_before_punchline/,
    );
  });

  it("enrichRecipeSilenceBeatFromDeadAir skips dramatic_pause hints", () => {
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        timeline: [{
          segmentId: "seg1",
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
    };
    const dramaticHint = {
      clipId: "clip01",
      startSec: 4,
      endSec: 7.5,
      source: "both",
      silenceKind: "dramatic_pause",
    };
    const audioIndex = {
      clips: [{ clipId: "clip01", deadAirHints: [dramaticHint] }],
    };

    const moments = enrichRecipeSilenceBeatFromDeadAir(recipe, { audioIndex });
    assert.equal(moments.filter((m) => m.techniqueId === "silence_beat").length, 0);
  });
});
