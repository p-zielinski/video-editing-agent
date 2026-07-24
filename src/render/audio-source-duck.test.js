import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_DUCK_CROSSFADE_SEC,
  buildSpeechAmbientSourcePlan,
  buildSourceDuckFilterGraph,
  collectSegmentRelativeSpeechIntervals,
} from "./audio-source-duck.js";

const baseSegment = {
  segmentId: "seg_a",
  audioInSec: 10,
  audioOutSec: 20,
  videoInSec: 10,
  videoOutSec: 20,
  preserveAmbientAudio: false,
};

const words = [
  { text: "hello", start: 10.5, end: 11.0 },
  { text: "world", start: 11.1, end: 11.5 },
  { text: "gap", start: 15.0, end: 15.4 },
];

describe("audio-source-duck", () => {
  it("collectSegmentRelativeSpeechIntervals maps source words into segment-local time", () => {
    const intervals = collectSegmentRelativeSpeechIntervals(words, 10, 20);
    assert.deepEqual(intervals, [
      { start: 0.5, end: 1.5 },
      { start: 5.0, end: 5.4 },
    ]);
  });

  it("collectSegmentRelativeSpeechIntervals uses audio range (not video) for JL-style offsets", () => {
    const jlWords = [
      { text: "lead", start: 8.0, end: 8.5 },
      { text: "body", start: 10.2, end: 10.8 },
    ];
    // audioIn=8..11 while video would be 10..11 — duck seeks to audioIn
    const intervals = collectSegmentRelativeSpeechIntervals(jlWords, 8, 11);
    assert.deepEqual(intervals, [
      { start: 0, end: 0.5 },
      { start: 2.2, end: 2.8 },
    ]);
  });

  it("buildSpeechAmbientSourcePlan uses enhanced in speech and original in gaps", () => {
    const plan = buildSpeechAmbientSourcePlan(
      baseSegment,
      words,
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );

    assert.equal(plan.mode, "speech_ambient_duck");
    assert.equal(plan.enhancedPath, "/work/enhanced.wav");
    assert.equal(plan.originalPath, "/inbox/original.mov");
    assert.equal(plan.durationSec, 10);
    assert.equal(plan.crossfadeSec, SOURCE_DUCK_CROSSFADE_SEC);
    assert.ok(plan.crossfadeSec >= 0.05 && plan.crossfadeSec <= 0.08);

    assert.deepEqual(plan.windows, [
      { startSec: 0, endSec: 0.5, source: "original" },
      { startSec: 0.5, endSec: 1.5, source: "enhanced" },
      { startSec: 1.5, endSec: 5.0, source: "original" },
      { startSec: 5.0, endSec: 5.4, source: "enhanced" },
      { startSec: 5.4, endSec: 10, source: "original" },
    ]);
  });

  it("buildSpeechAmbientSourcePlan forces original when preserveAmbientAudio", () => {
    const plan = buildSpeechAmbientSourcePlan(
      { ...baseSegment, preserveAmbientAudio: true },
      words,
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );

    assert.equal(plan.mode, "original_only");
    assert.equal(plan.enhancedPath, null);
    assert.deepEqual(plan.windows, [
      { startSec: 0, endSec: 10, source: "original" },
    ]);
  });

  it("buildSpeechAmbientSourcePlan falls back to original when enhanced missing", () => {
    const plan = buildSpeechAmbientSourcePlan(
      baseSegment,
      words,
      null,
      "/inbox/original.mov",
    );

    assert.equal(plan.mode, "original_only");
    assert.deepEqual(plan.windows, [
      { startSec: 0, endSec: 10, source: "original" },
    ]);
  });

  it("buildSpeechAmbientSourcePlan keeps enhanced-only when no speech words", () => {
    const plan = buildSpeechAmbientSourcePlan(
      baseSegment,
      [{ text: "out", start: 0, end: 1 }],
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );

    assert.equal(plan.mode, "enhanced_only");
    assert.deepEqual(plan.windows, [
      { startSec: 0, endSec: 10, source: "enhanced" },
    ]);
  });

  it("buildSourceDuckFilterGraph includes both sources, crossfade, and amix for duck mode", () => {
    const plan = buildSpeechAmbientSourcePlan(
      baseSegment,
      words,
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );
    const { filters, outputLabel } = buildSourceDuckFilterGraph(plan, {
      enhancedLabel: "[1:a]",
      originalLabel: "[2:a]",
      outputLabel: "[aduck]",
    });

    assert.equal(outputLabel, "[aduck]");
    assert.equal(filters.length, 3);
    assert.match(filters[0], /^\[1:a\]volume='/);
    assert.match(filters[0], /eval=frame\[enhg\]$/);
    assert.match(filters[1], /^\[2:a\]volume='/);
    assert.match(filters[1], /eval=frame\[origg\]$/);
    assert.match(
      filters[2],
      new RegExp(
        `\\[enhg\\]\\[origg\\]amix=inputs=2:duration=first:normalize=0:dropout_transition=${SOURCE_DUCK_CROSSFADE_SEC}\\[aduck\\]`,
      ),
    );

    // Enhanced volume should rise around first speech window (~0.5s)
    assert.match(filters[0], /0\.5/);
    // Original should be active in leading gap
    assert.ok(filters[0].includes("if(") || filters[0].includes("between"));
    assert.ok(filters[1].includes("if(") || filters[1].includes("between"));
  });

  it("buildSourceDuckFilterGraph passthrough for original_only", () => {
    const plan = buildSpeechAmbientSourcePlan(
      { ...baseSegment, preserveAmbientAudio: true },
      words,
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );
    const { filters, outputLabel } = buildSourceDuckFilterGraph(plan, {
      originalLabel: "[1:a]",
      outputLabel: "[aout]",
    });
    assert.deepEqual(filters, ["[1:a]anull[aout]"]);
    assert.equal(outputLabel, "[aout]");
  });

  it("buildSourceDuckFilterGraph passthrough for enhanced_only", () => {
    const plan = buildSpeechAmbientSourcePlan(
      baseSegment,
      [],
      "/work/enhanced.wav",
      "/inbox/original.mov",
    );
    const { filters } = buildSourceDuckFilterGraph(plan, {
      enhancedLabel: "[1:a]",
      outputLabel: "[aout]",
    });
    assert.deepEqual(filters, ["[1:a]anull[aout]"]);
  });
});
