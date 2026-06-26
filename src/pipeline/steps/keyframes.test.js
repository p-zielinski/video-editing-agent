import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planHybridKeyframes,
  speechTimestampsFromWords,
  resolveMaxFramesPerMin,
  BROLL_MAX_FRAMES_PER_MIN,
  DEFAULT_MAX_FRAMES_PER_MIN,
} from "./keyframes.js";

describe("hybrid keyframes", () => {
  it("plans keyframes from scenes and speech", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 30, durationSec: 30 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 30, endSec: 60, durationSec: 30 },
    ];
    const words = [
      { start: 5, end: 5.5 },
      { start: 35, end: 35.5 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words,
      clipId: "clip01",
      durationSec: 60,
      maxFramesPerMin: 6,
    });

    assert.ok(frames.length >= 2);
    assert.ok(frames.some((f) => f.trigger === "speech"));
    assert.ok(frames.some((f) => f.trigger === "scene_cut"));
  });

  it("adds motion keyframes when scene durations diverge", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10, durationSec: 10 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 10, endSec: 40, durationSec: 30 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip01",
      durationSec: 40,
      maxFramesPerMin: 12,
    });

    assert.ok(frames.some((f) => f.trigger === "motion"));
  });

  it("adds motion keyframes when scene cutScore exceeds threshold", () => {
    const scenes = [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 10, durationSec: 10 },
      { sceneId: "clip01_scene002", clipId: "clip01", startSec: 10, endSec: 20, durationSec: 10, cutScore: 0.5 },
    ];

    const frames = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip01",
      durationSec: 20,
      maxFramesPerMin: 12,
    });

    assert.ok(frames.some((f) => f.trigger === "motion"));
  });

  it("extracts speech timestamps with ±2s window", () => {
    const ts = speechTimestampsFromWords([
      { start: 10, end: 10.5 },
      { start: 20, end: 20.5 },
    ], 2);

    assert.ok(ts.includes(10));
    assert.ok(ts.includes(8));
    assert.ok(ts.includes(12));
    assert.ok(ts.includes(18));
    assert.ok(ts.includes(22));
  });

  it("exports B-roll and default max frames per minute constants", () => {
    assert.equal(BROLL_MAX_FRAMES_PER_MIN, 12);
    assert.equal(DEFAULT_MAX_FRAMES_PER_MIN, 6);
  });

  it("resolveMaxFramesPerMin uses 12 for broll_pool or silent clips", () => {
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { clipRole: "broll_pool" }, words: [] }),
      12,
    );
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { hasSpeech: false }, words: [] }),
      12,
    );
    assert.equal(
      resolveMaxFramesPerMin({ clipEntry: { clipRole: "aroll_primary", hasSpeech: true }, words: [{ start: 1, end: 2 }] }),
      6,
    );
  });

  it("plans more keyframes for B-roll density than default speech clips", () => {
    const scenes = Array.from({ length: 8 }, (_, i) => ({
      sceneId: `clip02_scene${String(i + 1).padStart(3, "0")}`,
      clipId: "clip02",
      startSec: i * 10,
      endSec: (i + 1) * 10,
      durationSec: 10,
    }));

    const dense = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip02",
      durationSec: 80,
      maxFramesPerMin: BROLL_MAX_FRAMES_PER_MIN,
    });
    const sparse = planHybridKeyframes({
      scenes,
      words: [],
      clipId: "clip02",
      durationSec: 80,
      maxFramesPerMin: DEFAULT_MAX_FRAMES_PER_MIN,
    });

    assert.ok(dense.length > sparse.length);
  });
});
