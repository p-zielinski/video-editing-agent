import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACT_TRANSITION_TOLERANCE_SEC,
  buildActTransitionHints,
  enrichRecipeActTransitions,
  MAX_ACT_TRANSITIONS_PER_MAIN,
} from "../../src/editorial/act-transitions.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
    { sceneId: "clip01_scene003", clipId: "clip01", startSec: 240, endSec: 360 },
  ],
};

const abstraction = {
  L2: [
    { segmentId: "seg_setup", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120, narrativeRole: "setup" },
    { segmentId: "seg_tension", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "tension" },
    { segmentId: "seg_climax", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "climax" },
    { segmentId: "seg_resolution", sceneIds: ["clip01_scene003"], startSec: 240, endSec: 360, narrativeRole: "resolution" },
  ],
};

function buildMainRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"], brollStrategy: "minimal" },
    clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 360,
        audioInSec: 0,
        audioOutSec: 360,
        audioPolicy: "from_video_ref",
      }],
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("buildActTransitionHints", () => {
  it("suggests dip_to_black at setup→tension and climax→resolution boundaries", () => {
    const recipe = buildMainRecipe();
    const hints = buildActTransitionHints(abstraction, null, { recipe });

    assert.equal(hints.length, 2);
    assert.equal(hints[0].techniqueId, "dip_to_black");
    assert.equal(hints[0].fromRole, "setup");
    assert.equal(hints[0].toRole, "tension");
    assert.equal(hints[0].targetSec, 120);
    assert.equal(hints[1].fromRole, "climax");
    assert.equal(hints[1].toRole, "resolution");
    assert.equal(hints[1].targetSec, 240);
    assert.ok(hints.length <= MAX_ACT_TRANSITIONS_PER_MAIN);
  });

  it("returns empty when no qualifying role transitions", () => {
    const hints = buildActTransitionHints({
      L2: [
        { segmentId: "seg_a", startSec: 0, endSec: 120, narrativeRole: "development" },
        { segmentId: "seg_b", startSec: 120, endSec: 240, narrativeRole: "payoff" },
      ],
    });
    assert.equal(hints.length, 0);
  });
});

describe("enrichRecipeActTransitions", () => {
  it("adds enrich_act_dip when director omitted dip_to_black within tolerance", () => {
    const recipe = buildMainRecipe();
    enrichRecipeActTransitions(recipe, { abstraction });

    const dips = recipe.creativeMoments.filter((m) => m.techniqueId === "dip_to_black");
    assert.equal(dips.length, 2);
    assert.ok(dips.every((m) => (m.momentId ?? "").startsWith("enrich_act_dip_")));
    assert.ok(dips.some((m) => Math.abs(m.outputStartSec - 120) <= 1));
    assert.ok(dips.some((m) => Math.abs(m.outputStartSec - 240) <= 1));
  });

  it("skips hint when director placed dip_to_black within tolerance", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "cm_dip_setup",
        techniqueId: "dip_to_black",
        outputId: "main_16x9",
        outputStartSec: 118,
        outputEndSec: 119,
      }],
    });

    enrichRecipeActTransitions(recipe, { abstraction });

    const dips = recipe.creativeMoments.filter((m) => m.techniqueId === "dip_to_black");
    assert.equal(dips.length, 2);
    assert.equal(
      dips.filter((m) => (m.momentId ?? "").startsWith("enrich_act_dip_")).length,
      1,
    );
    assert.ok(
      dips.some((m) => Math.abs(m.outputStartSec - 240) <= ACT_TRANSITION_TOLERANCE_SEC),
    );
  });

  it("caps enrich dips at MAX_ACT_TRANSITIONS_PER_MAIN when director has none", () => {
    const longAbstraction = {
      L2: [
        { segmentId: "s1", startSec: 0, endSec: 60, narrativeRole: "setup" },
        { segmentId: "s2", startSec: 60, endSec: 120, narrativeRole: "tension" },
        { segmentId: "s3", startSec: 120, endSec: 180, narrativeRole: "climax" },
        { segmentId: "s4", startSec: 180, endSec: 240, narrativeRole: "resolution" },
        { segmentId: "s5", startSec: 240, endSec: 300, narrativeRole: "setup" },
        { segmentId: "s6", startSec: 300, endSec: 360, narrativeRole: "tension" },
      ],
    };
    const recipe = buildMainRecipe();
    enrichRecipeActTransitions(recipe, { abstraction: longAbstraction });

    const enrichDips = recipe.creativeMoments.filter(
      (m) => (m.momentId ?? "").startsWith("enrich_act_dip_"),
    );
    assert.equal(enrichDips.length, MAX_ACT_TRANSITIONS_PER_MAIN);
  });
});

describe("applyDeterministicRecipeEnrichers act transition integration", () => {
  it("adds act dip transitions on narrative main", () => {
    const recipe = buildMainRecipe({
      vlogRetentionProfile: { enabled: false },
    });

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction,
      timelineIndex,
      batchContext: { brollStrategy: "minimal" },
    });

    const dips = recipe.creativeMoments?.filter((m) => m.techniqueId === "dip_to_black") ?? [];
    assert.ok(dips.length >= 1);
  });
});
