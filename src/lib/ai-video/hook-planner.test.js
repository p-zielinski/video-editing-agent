import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAiHook } from "./hook-planner.js";

describe("planAiHook", () => {
  const abstraction = {
    L3: {
      synopsis: "Dzień na rowerze",
      topics: ["cycling", "outdoors"],
      openLoops: [{
        kind: "cold_open",
        payoffSceneId: "clip01_scene002",
        setupSceneId: "clip01_scene001",
      }],
    },
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
    assert.equal(plan.durationSec, 5);
    assert.ok(plan.firstFrameSec < plan.lastFrameSec);
  });
});
