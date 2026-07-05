import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichUnpickedL2Bridges } from "./bridge-enrich.js";

describe("bridge-enrich", () => {
  it("adds crossfade bridge moment for unpicked L2 between picks", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", summary: "Intro", startSec: 0, endSec: 120 },
        { segmentId: "seg002", summary: "Skipped middle", startSec: 120, endSec: 240 },
        { segmentId: "seg003", summary: "Finale", startSec: 240, endSec: 360 },
      ],
    };
    const superPlan = {
      segmentOrder: ["seg001", "seg003"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg003", priority: 2 },
      ],
    };
    const recipe = {
      outputs: [{
        outputId: "main_16x9",
        outputKind: "main",
        format: "16:9",
        timeline: [
          { segmentId: "t1", outputStartSec: 0, outputEndSec: 100 },
          { segmentId: "t2", outputStartSec: 100, outputEndSec: 200 },
        ],
      }],
      creativeMoments: [],
    };

    enrichUnpickedL2Bridges(recipe, { abstraction, superPlan });

    assert.equal(recipe.bridgeMontageHints?.length, 1);
    assert.equal(recipe.bridgeMontageHints[0].unpickedL2SegmentId, "seg002");
    assert.equal(recipe.creativeMoments.length, 1);
    assert.equal(recipe.creativeMoments[0].techniqueId, "crossfade");
    assert.equal(recipe.creativeMoments[0].outputStartSec, 100);
  });
});
