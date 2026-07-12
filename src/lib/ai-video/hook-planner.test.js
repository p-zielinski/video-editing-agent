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
    },
    L1: [{
      sceneId: "clip01_scene002",
      summary: "Rowerzysta wjeżdża na szczyt o zachodzie słońca.",
      topics: ["cycling", "outdoors"],
    }],
  };

  const timelineIndex = {
    scenes: [
      {
        sceneId: "clip01_scene001",
        clipId: "clip01",
        sourcePath: "/inbox/a.mov",
        startSec: 0,
        endSec: 10,
      },
      {
        sceneId: "clip01_scene002",
        clipId: "clip01",
        sourcePath: "/inbox/a.mov",
        startSec: 10,
        endSec: 20,
      },
    ],
  };

  it("returns null when aiVideoEnabled is false", () => {
    assert.equal(planAiHook({
      abstraction,
      timelineIndex,
      batchContext: { aiVideoEnabled: false },
    }), null);
  });

  it("returns plan with prompt and frame timestamps when enabled", () => {
    const plan = planAiHook({
      abstraction,
      timelineIndex,
      batchContext: {
        aiVideoEnabled: true,
        aiVideoTargetOutputs: ["9:16"],
        aiVideoMaxDurationSec: 5,
      },
    });
    assert.ok(plan);
    assert.ok(plan.prompt.includes("cycling"));
    assert.ok(plan.prompt.includes("trudnym podjazdem"));
    assert.ok(plan.prompt.includes("Rowerzysta wjeżdża na szczyt"));
    assert.equal(plan.prompt.includes("clip01_scene002"), false);
    assert.equal(plan.durationSec, 5);
    assert.ok(plan.firstFrameSec < plan.lastFrameSec);
  });
});
