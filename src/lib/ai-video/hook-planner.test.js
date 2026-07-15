import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAiHook } from "./hook-planner.js";

describe("planAiHook", () => {
  const abstraction = {
    L3: {
      sessionSummary: "Rowerzysta walczy z trudnym podjazdem i dociera na szczyt.",
      narrativeArc: "wysiłek → kryzys → satysfakcja",
      openLoops: [{
        kind: "cold_open",
        payoffSceneId: "clip01_scene002",
        setupSceneId: "clip01_scene001",
      }],
      hookCreativeBrief: {
        strategy: "contextual",
        narrativePromise: "Zapowiedź wysiłku bez spoilera",
        contextualLink: "Łączy podjazd z determinacją",
        mustAvoid: ["spoilery", "napisy"],
        visualTone: "energia",
      },
    },
    L1: [
      {
        sceneId: "clip01_scene002",
        summary: "Rowerzysta wjeżdża na szczyt o zachodzie słońca.",
        topics: ["cycling", "outdoors"],
      },
      {
        sceneId: "clip01_scene003",
        summary: "Ujęcie szlaku przed szczytem.",
        topics: ["trail"],
        brollPotential: 0.8,
        visualQuality: "high",
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

  const enabledContext = {
    aiVideoEnabled: true,
    aiVideoTargetOutputs: ["9:16"],
    aiVideoMaxDurationSec: 5,
  };

  it("returns null when aiVideoEnabled is false", () => {
    assert.equal(planAiHook({
      abstraction,
      timelineIndex,
      batchContext: { aiVideoEnabled: false },
    }), null);
  });

  it("avoids spoiler payoff scene and uses brief-driven prompt", () => {
    const plan = planAiHook({
      abstraction,
      timelineIndex,
      batchContext: enabledContext,
    });
    assert.ok(plan);
    assert.equal(plan.hookSceneId, "clip01_scene003");
    assert.equal(plan.hookSource, "scene_rank_anti_spoiler");
    assert.ok(plan.hookSelection?.rankedAlternatives?.length > 0);
    assert.ok(plan.prompt.includes("Zapowiedź wysiłku bez spoilera"));
    assert.ok(plan.prompt.includes("Łączy podjazd z determinacją"));
    assert.ok(plan.prompt.includes("trail"));
    assert.equal(plan.prompt.includes("clip01_scene002"), false);
    assert.equal(plan.durationSec, 5);
    assert.ok(plan.firstFrameSec < plan.lastFrameSec);
  });

  it("falls back to legacy prompt when L3 has no brief", () => {
    const legacyAbstraction = {
      ...abstraction,
      L3: {
        ...abstraction.L3,
        hookCreativeBrief: undefined,
      },
    };
    const plan = planAiHook({
      abstraction: legacyAbstraction,
      timelineIndex,
      batchContext: enabledContext,
    });
    assert.ok(plan);
    assert.ok(plan.prompt.includes("trudnym podjazdem"));
    assert.equal(plan.hookCreativeBrief, null);
  });

  it("returns null when no safe scene has source path", () => {
    const noSourceTimeline = {
      scenes: timelineIndex.scenes.map((scene) => ({
        ...scene,
        sourcePath: scene.sceneId === "clip01_scene003" ? undefined : scene.sourcePath,
      })),
      words: [],
    };
    const tightAbstraction = {
      L3: { openLoops: abstraction.L3.openLoops },
      L1: [abstraction.L1[1]],
    };
    assert.equal(planAiHook({
      abstraction: tightAbstraction,
      timelineIndex: {
        scenes: noSourceTimeline.scenes.filter((s) => s.sceneId === "clip01_scene003"),
        words: [],
      },
      batchContext: enabledContext,
    }), null);
  });
});
