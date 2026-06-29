import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClipRegistry } from "./clip-profile.js";
import { writeJson, ARTIFACTS } from "../work-paths.js";

const baseCatalog = {
  batchId: "test01",
  clips: [
    { clipId: "clip01", fileName: "01_talk.MOV", sourcePath: "/in/01_talk.MOV", durationSec: 300 },
    { clipId: "clip02", fileName: "02_broll.MOV", sourcePath: "/in/02_broll.MOV", durationSec: 60 },
    { clipId: "clip03", fileName: "03_outtakes.MOV", sourcePath: "/in/03_outtakes.MOV", durationSec: 120 },
  ],
};

function makeTimelineIndex(overrides = {}) {
  return {
    batchId: "test01",
    clips: baseCatalog.clips.map((c) => ({ clipId: c.clipId, durationSec: c.durationSec })),
    scenes: [
      { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 300, durationSec: 300, hasSpeech: true },
      { sceneId: "clip02_scene001", clipId: "clip02", startSec: 0, endSec: 60, durationSec: 60, hasSpeech: false },
      { sceneId: "clip03_scene001", clipId: "clip03", startSec: 0, endSec: 10, durationSec: 10, hasSpeech: true, cutScore: 0.5 },
      { sceneId: "clip03_scene002", clipId: "clip03", startSec: 10, endSec: 20, durationSec: 10, hasSpeech: true, cutScore: 0.45 },
    ],
    words: [
      ...Array.from({ length: 50 }, (_, i) => ({
        wordId: `clip01_w${String(i + 1).padStart(3, "0")}`,
        word: "słowo",
        start: i,
        end: i + 0.5,
        isFiller: false,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        wordId: `clip03_w${String(i + 1).padStart(3, "0")}`,
        word: i % 2 === 0 ? "yyy" : "eee",
        start: i,
        end: i + 0.3,
        isFiller: true,
      })),
    ],
    visionCaptions: [
      { sceneId: "clip02_scene001", timestampSec: 5, caption: "jedzenie na talerzu" },
      { sceneId: "clip02_scene001", timestampSec: 15, caption: "restauracja" },
      { sceneId: "clip02_scene001", timestampSec: 25, caption: "zbliżenie" },
    ],
    objectDetections: [
      { sceneId: "clip02_scene001", timestampSec: 5, label: "food", confidence: 0.9 },
    ],
    keyframes: [
      { sceneId: "clip02_scene001", timestampSec: 5, trigger: "scene_cut" },
      { sceneId: "clip02_scene001", timestampSec: 30, trigger: "motion" },
    ],
    ...overrides,
  };
}

describe("clip_profile", () => {
  it("assigns aroll_primary to speech-heavy clip", () => {
    const registry = buildClipRegistry(makeTimelineIndex(), baseCatalog);
    const talk = registry.find((c) => c.clipId === "clip01");
    assert.equal(talk.clipRole, "aroll_primary");
    assert.equal(talk.hasSpeech, true);
    assert.equal(talk.roleSource, "clip_profile");
  });

  it("assigns broll_pool to silent clip with vision data", () => {
    const registry = buildClipRegistry(makeTimelineIndex(), baseCatalog);
    const broll = registry.find((c) => c.clipId === "clip02");
    assert.equal(broll.clipRole, "broll_pool");
    assert.equal(broll.hasSpeech, false);
    assert.ok(broll.roleConfidence >= 0.7);
    assert.equal(broll.visualQuality, "high");
  });

  it("assigns outtakes to high filler ratio clip", () => {
    const registry = buildClipRegistry(makeTimelineIndex(), baseCatalog);
    const outtakes = registry.find((c) => c.clipId === "clip03");
    assert.equal(outtakes.clipRole, "outtakes");
    assert.equal(outtakes.excludeFromMainStory, true);
  });

  it("assigns narration_track to audio-only clip with speech", () => {
    const catalog = {
      ...baseCatalog,
      clips: [
        {
          clipId: "clip04",
          fileName: "04_narration.wav",
          sourcePath: "/in/04_narration.wav",
          durationSec: 95,
          mediaType: "audio_only",
        },
      ],
    };
    const timeline = makeTimelineIndex({
      scenes: [
        {
          sceneId: "clip04_scene001",
          clipId: "clip04",
          startSec: 0,
          endSec: 95,
          durationSec: 95,
          hasSpeech: true,
        },
      ],
      words: Array.from({ length: 30 }, (_, i) => ({
        wordId: `clip04_w${String(i + 1).padStart(3, "0")}`,
        word: "narracja",
        start: i,
        end: i + 0.4,
        isFiller: false,
      })),
    });

    const registry = buildClipRegistry(timeline, catalog);
    const narration = registry.find((c) => c.clipId === "clip04");
    assert.equal(narration.clipRole, "narration_track");
    assert.equal(narration.mediaType, "audio_only");
    assert.equal(narration.hasSpeech, true);
  });

  it("merges audioTags from 01b into clip registry topics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-audio-"));
    writeJson(path.join(dir, ARTIFACTS.audioAnalysis("clip02")), {
      version: "1.0",
      clipId: "clip02",
      durationSec: 60,
      voiceLufs: -18,
      analysisMode: "stub",
      editorialTags: [
        { tag: "laughter", category: "reaction", count: 2, peakScore: 0.8, totalDurationSec: 1.2 },
      ],
      audioEvents: [],
    });

    const registry = buildClipRegistry(makeTimelineIndex(), baseCatalog, { workDir: dir });
    const broll = registry.find((c) => c.clipId === "clip02");
    assert.ok(broll.audioTags?.includes("laughter"));
    assert.ok(broll.topics?.includes("laughter"));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
