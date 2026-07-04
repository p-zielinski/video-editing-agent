import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_ENRICH_MOMENT_PREFIX,
  enrichRecipeCallbackMoments,
  MAX_CALLBACK_ENRICH_PER_MAIN,
} from "../../src/editorial/callback-enrich.js";
import { mergeSegmentRecipes } from "../../src/lib/recipe-merge.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";
import { validateNarrativeCallbackUndelivered } from "../../src/validators/narrative.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
    { sceneId: "clip01_scene003", clipId: "clip01", startSec: 240, endSec: 360 },
    { sceneId: "clip01_scene099", clipId: "clip01", startSec: 360, endSec: 480 },
  ],
};

const abstractionCallback = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
    { segmentId: "seg003", sceneIds: ["clip01_scene003"], startSec: 240, endSec: 360 },
  ],
  L3: {
    openLoops: [{
      loopId: "loop_cb",
      kind: "callback",
      setupSceneId: "clip01_scene001",
      payoffSceneId: "clip01_scene002",
      teaseText: "Remember the restaurant?",
    }],
  },
};

function buildMainRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"] },
    clipRegistry: [{ clipId: "clip01", durationSec: 480 }],
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
        videoOutSec: 480,
        audioInSec: 0,
        audioOutSec: 480,
        audioPolicy: "from_video_ref",
        cuts: [],
      }],
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("enrichRecipeCallbackMoments", () => {
  it("adds enrich_callback_001 match_cut when callback open loop lacks delivery", () => {
    const recipe = buildMainRecipe();

    const moments = enrichRecipeCallbackMoments(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    const callback = moments[0];
    assert.equal(callback.momentId, `${CALLBACK_ENRICH_MOMENT_PREFIX}001`);
    assert.equal(callback.techniqueId, "match_cut");
    assert.equal(callback.outputId, "main_16x9");
    assert.ok(Math.abs(callback.outputStartSec - 180) <= 30);
    assert.match(callback.reason, /loop_cb/);
  });

  it("skips when match_cut already exists near payoffSceneId", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "director_match",
        techniqueId: "match_cut",
        outputId: "main_16x9",
        outputStartSec: 175,
        outputEndSec: 176,
        reason: "Director callback",
        confidence: 0.8,
      }],
    });

    const moments = enrichRecipeCallbackMoments(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    assert.equal(moments[0].momentId, "director_match");
  });

  it("uses structuredCallbacks from recipe when L3 openLoops absent", () => {
    const recipe = buildMainRecipe({
      structuredCallbacks: [{
        callbackId: "cb_super",
        setupSceneId: "clip01_scene001",
        payoffSceneId: "clip01_scene003",
        teaseText: "Full circle",
      }],
    });

    const moments = enrichRecipeCallbackMoments(recipe, {
      abstraction: { L2: abstractionCallback.L2, L3: {} },
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "match_cut");
    assert.ok(Math.abs(moments[0].outputStartSec - 300) <= 30);
    assert.match(moments[0].reason, /cb_super/);
  });

  it(`adds at most ${MAX_CALLBACK_ENRICH_PER_MAIN} callback enrichments per main output`, () => {
    const recipe = buildMainRecipe();
    const abstraction = {
      L2: abstractionCallback.L2,
      L3: {
        openLoops: [
          {
            loopId: "loop_cb1",
            kind: "callback",
            setupSceneId: "clip01_scene001",
            payoffSceneId: "clip01_scene002",
          },
          {
            loopId: "loop_cb2",
            kind: "callback",
            setupSceneId: "clip01_scene001",
            payoffSceneId: "clip01_scene003",
          },
          {
            loopId: "loop_cb3",
            kind: "callback",
            setupSceneId: "clip01_scene001",
            payoffSceneId: "clip01_scene099",
          },
        ],
      },
    };

    const moments = enrichRecipeCallbackMoments(recipe, { abstraction, timelineIndex });

    assert.equal(moments.length, MAX_CALLBACK_ENRICH_PER_MAIN);
    assert.equal(moments[0].momentId, `${CALLBACK_ENRICH_MOMENT_PREFIX}001`);
    assert.equal(moments[1].momentId, `${CALLBACK_ENRICH_MOMENT_PREFIX}002`);
  });

  it("falls back to setup emphasis overlay when payoff scene cannot be mapped", () => {
    const recipe = buildMainRecipe({
      structuredCallbacks: [{
        callbackId: "cb_missing_payoff",
        setupSceneId: "clip01_scene001",
        payoffSceneId: "clip99_scene999",
        teaseText: "Coming back to this",
      }],
    });

    const moments = enrichRecipeCallbackMoments(recipe, {
      abstraction: { L2: abstractionCallback.L2, L3: {} },
      timelineIndex,
    });

    assert.equal(moments.length, 0);
    const overlay = recipe.outputs[0].timeline[0].textOverlays?.[0];
    assert.ok(overlay);
    assert.equal(overlay.overlayId, `${CALLBACK_ENRICH_MOMENT_PREFIX}001`);
    assert.equal(overlay.text, "Coming back to this");
    assert.equal(overlay.style, "emphasis");
  });

  it("clears NAR-CALLBACK-UNDELIVERED for callback open loop", () => {
    const recipe = buildMainRecipe();

    enrichRecipeCallbackMoments(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });

    const issues = validateNarrativeCallbackUndelivered(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });

  it("is wired in applyDeterministicRecipeEnrichers after payoff enrich", () => {
    const recipe = buildMainRecipe();

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction: abstractionCallback,
      timelineIndex,
      audioIndex: null,
      clipRegistry: recipe.clipRegistry,
      perClipAnalysis: {},
      batchContext: recipe.batchContext,
    });

    const callbackMoment = recipe.creativeMoments.find(
      (moment) => moment.momentId === `${CALLBACK_ENRICH_MOMENT_PREFIX}001`,
    );
    assert.ok(callbackMoment);
    assert.equal(callbackMoment.techniqueId, "match_cut");
  });
});

describe("mergeSegmentRecipes structuredCallbacks", () => {
  it("copies crossSegmentCallbacks from super plan onto merged recipe", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      crossSegmentCallbacks: [{
        callbackId: "cb_echo",
        setupSceneId: "clip01_scene001",
        payoffSceneId: "clip01_scene002",
        teaseText: "Echo",
      }],
    };
    const partial = buildMainRecipe({ segmentId: "seg001" });

    const merged = mergeSegmentRecipes(superPlan, [partial]);
    assert.equal(merged.structuredCallbacks.length, 1);
    assert.equal(merged.structuredCallbacks[0].callbackId, "cb_echo");
  });
});
