import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildColdOpenSegmentHint,
  buildNarrativeOpenLoops,
} from "../../src/editorial/chapter-hints.js";

const abstractionBase = {
  L2: [
    {
      segmentId: "seg001",
      startSec: 0,
      endSec: 300,
      sceneIds: ["clip01_scene001"],
      summary: "Intro.",
    },
    {
      segmentId: "seg002",
      startSec: 300,
      endSec: 600,
      sceneIds: ["clip01_scene002"],
      summary: "Payoff w restauracji.",
    },
  ],
  L3: {
    sessionSummary: "Vlog o restauracji.",
    narrativeArc: "intro → restauracja → podsumowanie",
  },
};

describe("buildNarrativeOpenLoops structural", () => {
  it("prefers structural openLoops over narrativeArc/sessionSummary text", () => {
    const abstraction = {
      ...abstractionBase,
      L3: {
        ...abstractionBase.L3,
        openLoops: [
          {
            loopId: "loop_01",
            kind: "cold_open",
            setupSceneId: "clip01_scene001",
            payoffSceneId: "clip01_scene002",
            teaseText: "Nie uwierzycie co było na końcu",
          },
          {
            loopId: "loop_02",
            kind: "callback",
            setupSceneId: "clip01_scene001",
            payoffSceneId: "clip01_scene002",
            teaseText: "Ta sama restauracja",
          },
        ],
      },
    };

    const loops = buildNarrativeOpenLoops(abstraction);
    assert.equal(loops.length, 2);
    assert.equal(loops[0].type, "cold_open");
    assert.equal(loops[0].loopId, "loop_01");
    assert.equal(loops[0].payoffSceneId, "clip01_scene002");
    assert.match(loops[0].hint, /Nie uwierzycie/);
    assert.equal(loops[1].type, "callback");
    assert.match(loops[1].hint, /callback/i);
  });

  it("falls back to narrativeArc and sessionSummary when openLoops absent", () => {
    const loops = buildNarrativeOpenLoops(abstractionBase);
    assert.equal(loops.length, 2);
    assert.equal(loops[0].type, "cold_open");
    assert.equal(loops[1].type, "payoff_tease");
    assert.match(loops[0].hint, /podsumowanie/);
    assert.match(loops[1].hint, /restauracji/);
  });

  it("buildColdOpenSegmentHint uses structural payoffSceneId for tease", () => {
    const abstraction = {
      ...abstractionBase,
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "cold_open",
          payoffSceneId: "clip01_scene002",
          teaseText: "Zapowiedź payoffu",
        }],
      },
    };

    const hint = buildColdOpenSegmentHint(abstraction, {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        targetDurationSec: 720,
      }],
    });

    assert.equal(hint?.suggestedSceneId, "clip01_scene002");
    assert.match(hint?.suggestion ?? "", /Zapowiedź payoffu/);
  });
});
