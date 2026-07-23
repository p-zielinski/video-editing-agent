import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GAP_DUCK_DB,
  SPEECH_DUCK_DB,
  collectOutputSpeechIntervals,
  collectSpeechArollClipIds,
  deriveSpeechDuckingWindows,
  enrichAudioEnhancementSpeechAccepts,
  enrichRecipeSpeechDucking,
  looksLikeIntentionalDuckingWindows,
  mergeIntervals,
} from "../../src/editorial/speech-ducking.js";
import { resolveDuckingWindows } from "../../src/render/audio-mix.js";

function makeOutput(timeline, outputId = "main_16x9") {
  return {
    outputId,
    format: "16:9",
    outputKind: "main",
    title: "Test",
    timeline,
  };
}

function makeArollSeg({
  clipId = "clip01",
  audioIn = 0,
  audioOut = 10,
  outputStart = 0,
  outputEnd = 10,
  role = "aroll",
} = {}) {
  return {
    segmentId: `seg_${clipId}_${outputStart}`,
    segmentRole: role,
    videoRef: { clipId, sceneId: `${clipId}_scene001` },
    audioRef: { clipId, sceneId: `${clipId}_scene001` },
    videoInSec: audioIn,
    videoOutSec: audioOut,
    audioInSec: audioIn,
    audioOutSec: audioOut,
    outputStartSec: outputStart,
    outputEndSec: outputEnd,
    audioPolicy: "from_video_ref",
  };
}

describe("speech-ducking", () => {
  it("mergeIntervals joins near-adjacent speech spans", () => {
    assert.deepEqual(
      mergeIntervals([
        { start: 0, end: 1 },
        { start: 1.2, end: 2 },
        { start: 5, end: 6 },
      ], 0.35),
      [
        { start: 0, end: 2 },
        { start: 5, end: 6 },
      ],
    );
  });

  it("collectOutputSpeechIntervals maps words onto output timeline", () => {
    const output = makeOutput([
      makeArollSeg({ audioIn: 10, audioOut: 20, outputStart: 0, outputEnd: 10 }),
    ]);
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w1", start: 10.5, end: 11.0, text: "hello" },
        { wordId: "clip01_w2", start: 11.1, end: 11.5, text: "world" },
        { wordId: "clip01_w3", start: 18.0, end: 18.4, text: "bye" },
      ],
    }];

    const intervals = collectOutputSpeechIntervals(output, { wordIndexes });
    assert.deepEqual(intervals, [
      { start: 0.5, end: 1.5 },
      { start: 8, end: 8.4 },
    ]);
  });

  it("deriveSpeechDuckingWindows ducks speech deep and gaps shallow", () => {
    const output = makeOutput([
      makeArollSeg({ audioOut: 20, outputEnd: 20 }),
    ]);
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w1", start: 2, end: 4, text: "hi" },
        { wordId: "clip01_w2", start: 10, end: 12, text: "there" },
      ],
    }];

    const windows = deriveSpeechDuckingWindows(output, {
      wordIndexes,
      endSec: 20,
    });

    assert.deepEqual(windows, [
      { startSec: 0, endSec: 2, duckingDb: GAP_DUCK_DB },
      { startSec: 2, endSec: 4, duckingDb: SPEECH_DUCK_DB },
      { startSec: 4, endSec: 10, duckingDb: GAP_DUCK_DB },
      { startSec: 10, endSec: 12, duckingDb: SPEECH_DUCK_DB },
      { startSec: 12, endSec: 20, duckingDb: GAP_DUCK_DB },
    ]);
  });

  it("deriveSpeechDuckingWindows returns shallow-only when no speech words", () => {
    const output = makeOutput([
      makeArollSeg({ audioOut: 8, outputEnd: 8 }),
    ]);
    const windows = deriveSpeechDuckingWindows(output, {
      wordIndexes: [{ clipId: "clip01", words: [] }],
      endSec: 8,
    });
    assert.deepEqual(windows, [
      { startSec: 0, endSec: 8, duckingDb: GAP_DUCK_DB },
    ]);
  });

  it("enrichRecipeSpeechDucking fills missing duckingWindows", () => {
    const recipe = {
      audioMixPlan: {
        musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 },
        segments: [{
          outputId: "main_16x9",
          musicInSec: 0,
          musicOutSec: 10,
          duckUnderVoice: true,
        }],
      },
      outputs: [
        makeOutput([
          makeArollSeg({ audioOut: 10, outputEnd: 10 }),
        ]),
      ],
    };
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w1", start: 1, end: 3, text: "hello" },
      ],
    }];

    const updated = enrichRecipeSpeechDucking(recipe, { wordIndexes });
    assert.equal(updated, 1);
    assert.deepEqual(recipe.audioMixPlan.segments[0].duckingWindows, [
      { startSec: 0, endSec: 1, duckingDb: GAP_DUCK_DB },
      { startSec: 1, endSec: 3, duckingDb: SPEECH_DUCK_DB },
      { startSec: 3, endSec: 10, duckingDb: GAP_DUCK_DB },
    ]);
  });

  it("enrichRecipeSpeechDucking preserves intentional director windows", () => {
    const intentional = [
      { startSec: 0, endSec: 15, duckingDb: -6 },
      { startSec: 15, endSec: 60, duckingDb: -12 },
    ];
    const recipe = {
      audioMixPlan: {
        musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 },
        segments: [{
          outputId: "main_16x9",
          musicOutSec: 60,
          duckUnderVoice: true,
          duckingWindows: intentional,
        }],
      },
      outputs: [makeOutput([makeArollSeg({ audioOut: 60, outputEnd: 60 })])],
    };
    const wordIndexes = [{
      clipId: "clip01",
      words: [{ wordId: "clip01_w1", start: 0, end: 5, text: "x" }],
    }];

    assert.equal(looksLikeIntentionalDuckingWindows(intentional, { musicOutSec: 60 }), true);
    assert.equal(enrichRecipeSpeechDucking(recipe, { wordIndexes }), 0);
    assert.deepEqual(recipe.audioMixPlan.segments[0].duckingWindows, intentional);
  });

  it("resolveDuckingWindows falls back to speech-derived windows when absent", () => {
    const output = makeOutput([
      makeArollSeg({ audioOut: 10, outputEnd: 10 }),
    ]);
    const wordIndexes = [{
      clipId: "clip01",
      words: [{ wordId: "clip01_w1", start: 2, end: 5, text: "hi" }],
    }];

    const windows = resolveDuckingWindows(
      { duckUnderVoice: true, musicOutSec: 10 },
      { musicBed: { duckingDb: -12 } },
      { output, wordIndexes },
    );

    assert.ok(windows.some((w) => w.duckingDb === SPEECH_DUCK_DB && w.startSec === 2));
    assert.ok(windows.some((w) => w.duckingDb === GAP_DUCK_DB && w.startSec === 0));
  });

  it("collectSpeechArollClipIds finds speech aroll only", () => {
    const recipe = {
      outputs: [makeOutput([
        makeArollSeg({ clipId: "clip_vo", audioOut: 5, outputEnd: 5 }),
        {
          ...makeArollSeg({ clipId: "clip_broll", audioOut: 5, outputStart: 5, outputEnd: 10, role: "broll" }),
          segmentRole: "broll",
        },
      ])],
    };
    const wordIndexes = [
      {
        clipId: "clip_vo",
        words: [{ wordId: "clip_vo_w1", start: 0, end: 1, text: "hi" }],
      },
      {
        clipId: "clip_broll",
        words: [{ wordId: "clip_broll_w1", start: 0, end: 1, text: "ambient" }],
      },
    ];

    const ids = collectSpeechArollClipIds(recipe, { wordIndexes });
    assert.deepEqual([...ids], ["clip_vo"]);
  });

  it("enrichAudioEnhancementSpeechAccepts accepts speech aroll without existing decision", () => {
    const recipe = {
      outputs: [makeOutput([
        makeArollSeg({ clipId: "clip_a", audioOut: 5, outputEnd: 5 }),
        makeArollSeg({ clipId: "clip_b", audioIn: 0, audioOut: 5, outputStart: 5, outputEnd: 10 }),
      ])],
      audioEnhancementDecisions: [],
    };
    const wordIndexes = [
      { clipId: "clip_a", words: [{ wordId: "a1", start: 0, end: 1, text: "hi" }] },
      { clipId: "clip_b", words: [{ wordId: "b1", start: 0, end: 1, text: "hi" }] },
    ];

    const changed = enrichAudioEnhancementSpeechAccepts(recipe, { wordIndexes });
    assert.equal(changed, 2);
    const byClip = Object.fromEntries(
      recipe.audioEnhancementDecisions.map((d) => [d.clipId, d]),
    );
    assert.equal(byClip.clip_a.action, "accept");
    assert.equal(byClip.clip_b.action, "accept");
  });

  it("enrichAudioEnhancementSpeechAccepts preserves existing reject decisions", () => {
    const recipe = {
      outputs: [makeOutput([
        makeArollSeg({ clipId: "clip_a", audioOut: 5, outputEnd: 5 }),
        makeArollSeg({ clipId: "clip_b", audioIn: 0, audioOut: 5, outputStart: 5, outputEnd: 10 }),
        makeArollSeg({ clipId: "clip_c", audioIn: 0, audioOut: 5, outputStart: 10, outputEnd: 15 }),
      ])],
      audioEnhancementDecisions: [
        {
          candidateId: "enh_clip_b",
          clipId: "clip_b",
          action: "reject",
          dialogueValue: "dispensable",
          reason: "not needed",
        },
        {
          candidateId: "enh_clip_c",
          clipId: "clip_c",
          action: "reject",
          dialogueValue: "essential",
          reason: "unrepairable clipping",
        },
      ],
    };
    const wordIndexes = [
      { clipId: "clip_a", words: [{ wordId: "a1", start: 0, end: 1, text: "hi" }] },
      { clipId: "clip_b", words: [{ wordId: "b1", start: 0, end: 1, text: "hi" }] },
      { clipId: "clip_c", words: [{ wordId: "c1", start: 0, end: 1, text: "hi" }] },
    ];

    const changed = enrichAudioEnhancementSpeechAccepts(recipe, { wordIndexes });
    assert.equal(changed, 1);
    const byClip = Object.fromEntries(
      recipe.audioEnhancementDecisions.map((d) => [d.clipId, d]),
    );
    assert.equal(byClip.clip_a.action, "accept");
    assert.equal(byClip.clip_b.action, "reject");
    assert.equal(byClip.clip_b.dialogueValue, "dispensable");
    assert.equal(byClip.clip_b.reason, "not needed");
    assert.equal(byClip.clip_c.action, "reject");
    assert.equal(byClip.clip_c.dialogueValue, "essential");
    assert.equal(byClip.clip_c.reason, "unrepairable clipping");
  });
});
