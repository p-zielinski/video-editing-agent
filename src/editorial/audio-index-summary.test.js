import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioIndexSummary,
  classifySilenceKind,
  fuseDeadAirHints,
} from "./audio-index-summary.js";

describe("buildAudioIndexSummary", () => {
  const audioIndex = {
    version: "1.0",
    batchId: "testbatch",
    clips: [
      {
        clipId: "clip01",
        voiceLufs: -17.2,
        beatCount: 3,
        beatTimes: [0.5, 1.0, 1.5],
        silenceGapCount: 2,
        totalSilenceSec: 2.0,
        recommendedTrackId: "upbeat_vlog_01",
        estimatedBpm: 120,
        audioEventCount: 0,
        editorialTags: ["laughter"],
      },
    ],
    batchSummary: {
      avgVoiceLufs: -17.2,
      totalSilenceSec: 2.0,
      dominantMood: "vlog",
      estimatedBpm: 120,
      clipCount: 1,
    },
    musicLibrary: { trackCount: 0, tracks: [] },
  };

  const perClipAnalysis = [
    {
      clipId: "clip01",
      cutSuggestions: [
        { timeSec: 0.5, reason: "beat", strength: 0.72 },
        { timeSec: 72, reason: "silence_start", strength: 0.65 },
        { timeSec: 1.0, reason: "beat", strength: 0.68 },
      ],
      silenceGaps: [
        { startSec: 10, endSec: 11, durationSec: 1.0 },
        { startSec: 72, endSec: 73.2, durationSec: 1.2 },
      ],
      energyCurve: [
        { startSec: 0, endSec: 1, rmsDb: -22.5 },
        { startSec: 1, endSec: 2, rmsDb: -18.0 },
        { startSec: 2, endSec: 3, rmsDb: -25.0 },
      ],
      audioEvents: [
        { startSec: 5, endSec: 5.5, label: "Laughter", score: 0.9 },
        { startSec: 12, endSec: 12.3, label: "Impact", score: 0.7 },
      ],
    },
  ];

  it("returns undefined when audioIndex has no clips", () => {
    assert.equal(buildAudioIndexSummary(null), undefined);
    assert.equal(buildAudioIndexSummary({ clips: [] }), undefined);
  });

  it("keeps existing rollup fields without perClipAnalysis", () => {
    const summary = buildAudioIndexSummary(audioIndex);
    assert.equal(summary.clipCount, 1);
    assert.deepEqual(summary.clips[0].beatTimestamps, [0.5, 1.0, 1.5]);
    assert.equal(summary.clips[0].cutSuggestions, undefined);
  });

  it("adds capped enrichment from perClipAnalysis", () => {
    const summary = buildAudioIndexSummary(audioIndex, { perClipAnalysis });
    const clip = summary.clips[0];

    assert.deepEqual(clip.cutSuggestions, [
      { timeSec: 0.5, reason: "beat", strength: 0.72 },
      { timeSec: 1.0, reason: "beat", strength: 0.68 },
      { timeSec: 72, reason: "silence_start", strength: 0.65 },
    ]);

    assert.deepEqual(clip.silenceGaps, [
      { startSec: 72, endSec: 73.2, durationSec: 1.2 },
      { startSec: 10, endSec: 11, durationSec: 1.0 },
    ]);

    assert.deepEqual(clip.energyPeaks, [
      { startSec: 1, endSec: 2, rmsDb: -18.0 },
      { startSec: 0, endSec: 1, rmsDb: -22.5 },
      { startSec: 2, endSec: 3, rmsDb: -25.0 },
    ]);

    assert.deepEqual(clip.audioEvents, [
      { timeSec: 5, label: "Laughter", strength: 0.9 },
      { timeSec: 12, label: "Impact", strength: 0.7 },
    ]);
  });

  it("reads nested fields from audioIndex clips when perClipAnalysis is absent", () => {
    const indexWithNested = {
      ...audioIndex,
      clips: [
        {
          ...audioIndex.clips[0],
          cutSuggestions: [{ timeSec: 3, reason: "beat", strength: 0.8 }],
          silenceGaps: [{ startSec: 1, endSec: 2, durationSec: 1 }],
        },
      ],
    };

    const summary = buildAudioIndexSummary(indexWithNested);
    assert.deepEqual(summary.clips[0].cutSuggestions, [
      { timeSec: 3, reason: "beat", strength: 0.8 },
    ]);
    assert.deepEqual(summary.clips[0].silenceGaps, [
      { startSec: 1, endSec: 2, durationSec: 1 },
    ]);
  });

  it("prefers perClipAnalysis over nested clip fields", () => {
    const indexWithNested = {
      ...audioIndex,
      clips: [
        {
          ...audioIndex.clips[0],
          cutSuggestions: [{ timeSec: 99, reason: "beat", strength: 0.1 }],
        },
      ],
    };

    const summary = buildAudioIndexSummary(indexWithNested, { perClipAnalysis });
    assert.equal(summary.clips[0].cutSuggestions[0].timeSec, 0.5);
  });

  it("accepts perClipAnalysis as a Map", () => {
    const map = new Map([[perClipAnalysis[0].clipId, perClipAnalysis[0]]]);
    const summary = buildAudioIndexSummary(audioIndex, { perClipAnalysis: map });
    assert.equal(summary.clips[0].cutSuggestions.length, 3);
  });

  it("classifySilenceKind defaults to dead_air without energy context", () => {
    assert.equal(classifySilenceKind({ startSec: 1, endSec: 2 }), "dead_air");
  });

  it("fuseDeadAirHints merges audio silence with transcript gaps", () => {
    const wordIndex = {
      clipId: "clip01",
      durationSec: 100,
      words: [
        { wordId: "clip01_w001", word: "cześć", start: 0, end: 1 },
        { wordId: "clip01_w002", word: "świat", start: 8, end: 9 },
        { wordId: "clip01_w003", word: "koniec", start: 90, end: 91 },
      ],
    };

    const hints = fuseDeadAirHints(
      {
        silenceGaps: [
          { startSec: 72, endSec: 73.2, durationSec: 1.2 },
          { startSec: 1.5, endSec: 2.5, durationSec: 1.0 },
        ],
      },
      wordIndex,
    );

    assert.ok(hints.some((hint) => hint.source === "both"));
    assert.ok(hints.some((hint) => hint.startSec <= 72 && hint.endSec >= 73.2));
    assert.ok(hints.some((hint) => hint.source === "transcript" && hint.startSec >= 9));
    assert.ok(hints.every((hint) => hint.endSec - hint.startSec > 0.5));
    assert.ok(hints.length <= 6);
  });

  it("adds deadAirHints per clip from wordIndexes", () => {
    const wordIndexes = [{
      clipId: "clip01",
      durationSec: 73.5,
      words: [
        { wordId: "clip01_w001", word: "cześć", start: 0, end: 1 },
        { wordId: "clip01_w002", word: "świat", start: 72.5, end: 73.5 },
      ],
    }];
    const analysis = [{
      clipId: "clip01",
      silenceGaps: [{ startSec: 72, endSec: 73.2, durationSec: 1.2 }],
    }];

    const summary = buildAudioIndexSummary(audioIndex, {
      perClipAnalysis: analysis,
      wordIndexes,
    });
    const hint = summary.clips[0].deadAirHints.find((entry) => entry.endSec === 73.2);
    assert.equal(hint.source, "both");
    assert.equal(hint.startSec, 1);
  });
});
