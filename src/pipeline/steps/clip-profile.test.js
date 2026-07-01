import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClipRegistry, refineClipRegistryFromL1, runClipRegistryRefineStep } from "./clip-profile.js";
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
  it("propagates creationTime from catalog into clip registry", () => {
    const catalog = {
      ...baseCatalog,
      clips: baseCatalog.clips.map((clip, index) => ({
        ...clip,
        creationTime: `2026-06-29T${String(8 + index).padStart(2, "0")}:00:00.000Z`,
      })),
    };

    const registry = buildClipRegistry(makeTimelineIndex(), catalog);
    assert.equal(registry[0].creationTime, "2026-06-29T08:00:00.000Z");
    assert.equal(registry[1].sortIndex, 1);
  });

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

  it("refineClipRegistryFromL1 promotes silent high-broll clip to broll_pool", () => {
    const timeline = makeTimelineIndex();
    const registry = buildClipRegistry(timeline, baseCatalog);
    const undecidedEntry = {
      ...registry.find((c) => c.clipId === "clip02"),
      clipRole: "undecided",
      roleSource: "clip_profile",
    };
    const abstraction = {
      L1: [{
        sceneId: "clip02_scene001",
        brollPotential: 0.85,
        topics: ["jedzenie", "restauracja"],
        mood: "warm",
      }],
    };

    const [refined] = refineClipRegistryFromL1([undecidedEntry], abstraction, timeline);
    assert.equal(refined.clipRole, "broll_pool");
    assert.equal(refined.roleSource, "l1_refined");
    assert.ok(refined.topics.includes("jedzenie"));
    assert.equal(refined.l1AvgBrollPotential, 0.85);
  });

  it("refineClipRegistryFromL1 assigns narration_track when L1 marks narration source", () => {
    const timeline = makeTimelineIndex({
      scenes: [{
        sceneId: "clip04_scene001",
        clipId: "clip04",
        startSec: 0,
        endSec: 95,
        durationSec: 95,
        hasSpeech: true,
      }],
      words: Array.from({ length: 30 }, (_, i) => ({
        wordId: `clip04_w${String(i + 1).padStart(3, "0")}`,
        word: "narracja",
        start: i,
        end: i + 0.4,
        isFiller: false,
      })),
    });
    const catalog = {
      batchId: "test01",
      clips: [{
        clipId: "clip04",
        fileName: "04_narration.wav",
        sourcePath: "/in/04_narration.wav",
        durationSec: 95,
        mediaType: "audio_only",
      }],
    };
    const registry = buildClipRegistry(timeline, catalog);
    const abstraction = {
      L1: [{
        sceneId: "clip04_scene001",
        brollPotential: 0.1,
        isNarrationSource: true,
        topics: ["voiceover"],
      }],
    };

    const [refined] = refineClipRegistryFromL1(registry, abstraction, timeline);
    assert.equal(refined.clipRole, "narration_track");
    assert.equal(refined.roleSource, "l1_refined");
    assert.ok(refined.topics.includes("voiceover"));
  });

  it("runClipRegistryRefineStep persists refined registry artifact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vea-clip-refine-"));
    const timeline = makeTimelineIndex();
    const registry = buildClipRegistry(timeline, baseCatalog);
    writeJson(path.join(dir, ARTIFACTS.timelineIndex), timeline);
    writeJson(path.join(dir, ARTIFACTS.clipRegistry), {
      version: "1.0",
      batchId: "test01",
      clipRegistry: registry,
    });
    writeJson(path.join(dir, ARTIFACTS.abstraction), {
      L1: [{
        sceneId: "clip02_scene001",
        brollPotential: 0.9,
        topics: ["makaron"],
      }],
    });

    const artifact = await runClipRegistryRefineStep({ workDir: dir });
    const broll = artifact.clipRegistry.find((c) => c.clipId === "clip02");
    assert.ok(broll.topics.includes("makaron"));
    assert.equal(broll.roleSource, "l1_refined");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
