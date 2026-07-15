import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectAiHookSpoilerSceneIds,
  rankAiHookSceneCandidates,
  selectAiHookScene,
} from "./ai-hook-scene.js";

describe("ai-hook-scene selection", () => {
  const abstraction = {
    L3: {
      openLoops: [{
        kind: "cold_open",
        payoffSceneId: "clip01_scene002",
        setupSceneId: "clip01_scene001",
      }],
    },
    L1: [
      {
        sceneId: "clip01_scene001",
        summary: "Setup podjazdu",
        brollPotential: 0.8,
        visualQuality: "high",
        topics: ["cycling"],
      },
      {
        sceneId: "clip01_scene002",
        summary: "Payoff na szczycie",
        brollPotential: 0.95,
        visualQuality: "high",
        topics: ["summit"],
      },
      {
        sceneId: "clip01_scene003",
        summary: "Alternatywny kadr",
        brollPotential: 0.7,
        visualQuality: "medium",
        topics: ["trail"],
      },
    ],
  };

  const timelineIndex = {
    scenes: [
      {
        sceneId: "clip01_scene001",
        clipId: "clip01",
        sourcePath: "/inbox/a.mov",
        startSec: 0,
        endSec: 10,
        hasSpeech: false,
      },
      {
        sceneId: "clip01_scene002",
        clipId: "clip01",
        sourcePath: "/inbox/a.mov",
        startSec: 10,
        endSec: 20,
        hasSpeech: false,
      },
      {
        sceneId: "clip01_scene003",
        clipId: "clip01",
        sourcePath: "/inbox/a.mov",
        startSec: 20,
        endSec: 30,
        hasSpeech: false,
      },
    ],
    words: [],
  };

  it("collects payoff and cold-open setup as spoilers", () => {
    const spoilers = collectAiHookSpoilerSceneIds(abstraction);
    assert.ok(spoilers.has("clip01_scene002"));
    assert.ok(spoilers.has("clip01_scene001"));
  });

  it("ranks candidates excluding spoiler scenes", () => {
    const candidates = rankAiHookSceneCandidates(abstraction, timelineIndex, null);
    assert.ok(candidates.every((entry) => entry.sceneId !== "clip01_scene002"));
    assert.ok(candidates.some((entry) => entry.sceneId === "clip01_scene003"));
  });

  it("selects next safe scene with metadata", () => {
    const selection = selectAiHookScene(abstraction, timelineIndex, null);
    assert.ok(selection);
    assert.equal(selection.sceneId, "clip01_scene003");
    assert.equal(selection.source, "scene_rank_anti_spoiler");
    assert.ok(selection.selection.rankedAlternatives.includes("clip01_scene003"));
    assert.ok(selection.selection.excludedSpoilerSceneIds.includes("clip01_scene002"));
  });

  it("returns null when every candidate is a spoiler or lacks source", () => {
    const onlySpoilers = {
      ...abstraction,
      L1: abstraction.L1.slice(0, 2),
    };
    const timeline = {
      scenes: timelineIndex.scenes.slice(0, 2),
      words: [],
    };
    assert.equal(selectAiHookScene(onlySpoilers, timeline, null), null);
  });
});
