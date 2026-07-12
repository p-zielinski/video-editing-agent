import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectWeakShortTail,
  enrichRecipeShortsOutroBracket,
  SHORT_OUTRO_BRACKET_MOMENT_ID,
  SHORT_OUTRO_BRACKET_OVERLAY_ID,
} from "../../src/editorial/shorts-outro-bracket.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";
import { buildOutputTimeline } from "../../src/lib/build-output-timeline.js";

const abstraction = {
  L2: [
    {
      segmentId: "l2_hook",
      sceneIds: ["clip01_scene001"],
      narrativeRole: "tension",
      title: "Wybuch w kuchni",
    },
    {
      segmentId: "l2_tail",
      sceneIds: ["clip01_scene002"],
      narrativeRole: "setup",
      summary: "Długie gadanie na koniec",
    },
  ],
  L3: {
    sessionSummary: "Krótki test o wybuchu w kuchni.",
  },
};

function buildShortRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["9:16"] },
    clipRegistry: [{ clipId: "clip01", durationSec: 60 }],
    creativityProfile: { level: "shorts", techniquePack: "shorts_retention_2026" },
    shortsRetentionProfile: { enabled: true },
    audioMixPlan: {
      musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 },
    },
    outputs: [{
      outputId: "short_9x16",
      outputKind: "short",
      format: "9:16",
      timeline: [
        {
          segmentId: "s1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 20,
          audioInSec: 0,
          audioOutSec: 20,
          audioPolicy: "from_video_ref",
        },
        {
          segmentId: "s2",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 20,
          videoOutSec: 40,
          audioInSec: 20,
          audioOutSec: 40,
          audioPolicy: "from_video_ref",
        },
      ],
    }],
    creativeMoments: [{
      momentId: "cm_beat_tail",
      techniqueId: "pattern_interrupt",
      outputId: "short_9x16",
      outputStartSec: 32,
      outputEndSec: 34,
      retentionRole: "beat",
      reason: "beat w słabym ogonie",
    }],
    ...extra,
  };
}

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 20, hasSpeech: true },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 20, endSec: 40, hasSpeech: true },
  ],
};

const abstractionL1 = {
  L1: [
    { sceneId: "clip01_scene001", visualQuality: "high", brollPotential: 0.2 },
    { sceneId: "clip01_scene002", visualQuality: "low", brollPotential: 0.1 },
  ],
  ...abstraction,
};

describe("detectWeakShortTail", () => {
  it("detects low-rank trailing segment after stronger opener", () => {
    const recipe = buildShortRecipe();
    const weak = detectWeakShortTail(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
      audioIndex: { clips: [] },
    });

    assert.ok(weak);
    assert.equal(weak.contentEndSec, 20);
    assert.equal(weak.reason, "weak_tail_scene");
  });

  it("returns null when short is too short", () => {
    const recipe = buildShortRecipe({
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        timeline: [{
          segmentId: "s1",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 12,
          audioInSec: 0,
          audioOutSec: 12,
          audioPolicy: "from_video_ref",
        }],
      }],
    });

    assert.equal(
      detectWeakShortTail(recipe, { abstraction: abstractionL1, timelineIndex }),
      null,
    );
  });
});

describe("enrichRecipeShortsOutroBracket", () => {
  it("materializes director shortsOutroBracket with trim, overlay and swell", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: {
        enabled: true,
        text: "Koniec.",
        endAtOutputSec: 22.5,
        bracketDurationSec: 2.5,
      },
    });

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction,
      timelineIndex,
      audioIndex: { clips: [] },
    });

    const short = recipe.outputs[0];
    const duration = buildOutputTimeline(short).at(-1)?.outputEndSec ?? 0;
    assert.ok(duration <= 22.6);
    assert.equal(short.timeline.length, 1);

    const overlays = short.timeline.flatMap((seg) => seg.textOverlays ?? []);
    const bracket = overlays.find((o) => o.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID);
    assert.ok(bracket);
    assert.equal(bracket.text, "Koniec.");
    assert.equal(bracket.style, "closure_bracket");
    assert.equal(bracket.role, "closure");
    assert.equal(bracket.outputStartSec, 20);
    assert.equal(bracket.outputEndSec, 22.5);

    const swell = recipe.creativeMoments.find(
      (moment) => moment.momentId === SHORT_OUTRO_BRACKET_MOMENT_ID,
    );
    assert.ok(swell);
    assert.equal(swell.techniqueId, "music_swell");
    assert.equal(swell.retentionRole, "closure");
    assert.equal(swell.params.gainDb, 5);

    assert.equal(recipe.shortsOutroBracketMeta.applied, true);
    assert.equal(recipe.shortsOutroBracketMeta.source, "director");
    assert.equal(
      recipe.creativeMoments.some((moment) => moment.momentId === "cm_beat_tail"),
      false,
    );
  });

  it("auto-applies on weak tail only when explicitly enabled", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: { enabled: true, auto: true },
    });

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
      audioIndex: { clips: [] },
    });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.ok(overlays.some((o) => o.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID));
    assert.equal(recipe.shortsOutroBracketMeta.source, "enricher");
  });

  it("does not auto-apply when shortsOutroBracket is absent", () => {
    const recipe = buildShortRecipe();

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
      audioIndex: { clips: [] },
    });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(overlays.length, 0);
    assert.equal(recipe.shortsOutroBracketMeta, undefined);
  });

  it("does not auto-detect from enabled alone", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: { enabled: true },
    });

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
      audioIndex: { clips: [] },
    });

    assert.equal(recipe.shortsOutroBracketMeta, undefined);
  });

  it("skips when shortsOutroBracket.enabled is false", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: { enabled: false },
    });

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
    });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(overlays.length, 0);
  });

  it("skips when director already placed closure overlay in tail", () => {
    const recipe = buildShortRecipe({
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        timeline: [
          {
            segmentId: "s1",
            videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
            videoInSec: 0,
            videoOutSec: 30,
            audioInSec: 0,
            audioOutSec: 30,
            textOverlays: [{
              overlayId: "director_closure",
              text: "Już.",
              outputStartSec: 26,
              outputEndSec: 29,
              style: "closure_bracket",
              role: "closure",
            }],
          },
        ],
      }],
    });

    enrichRecipeShortsOutroBracket(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
    });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].overlayId, "director_closure");
  });

  it("is idempotent", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: {
        enabled: true,
        text: "I tyle.",
        endAtOutputSec: 22.5,
      },
    });

    enrichRecipeShortsOutroBracket(recipe, { abstraction, timelineIndex });
    enrichRecipeShortsOutroBracket(recipe, { abstraction, timelineIndex });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(
      overlays.filter((o) => o.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID).length,
      1,
    );
  });

  it("re-evaluates after fixer extends an already bracketed short", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: {
        enabled: true,
        text: "I tyle.",
        endAtOutputSec: 22.5,
      },
    });

    enrichRecipeShortsOutroBracket(recipe, { abstraction, timelineIndex });
    recipe.outputs[0].timeline.push({
      segmentId: "fixer_tail",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
      videoInSec: 30,
      videoOutSec: 40,
      audioInSec: 30,
      audioOutSec: 40,
      audioPolicy: "from_video_ref",
    });

    enrichRecipeShortsOutroBracket(recipe, { abstraction, timelineIndex });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.equal(
      overlays.filter((o) => o.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID).length,
      1,
    );
    assert.equal(recipe.outputs[0].targetDurationSec, 22.5);
    assert.ok(
      (buildOutputTimeline(recipe.outputs[0]).at(-1)?.outputEndSec ?? 0) <= 22.5,
    );
  });

  it("omits music swell when no music bed exists", () => {
    const recipe = buildShortRecipe({
      audioMixPlan: undefined,
      shortsOutroBracket: {
        enabled: true,
        text: "Koniec.",
        endAtOutputSec: 22.5,
      },
    });

    enrichRecipeShortsOutroBracket(recipe, { abstraction, timelineIndex });

    assert.equal(
      recipe.creativeMoments.some(
        (moment) => moment.momentId === SHORT_OUTRO_BRACKET_MOMENT_ID,
      ),
      false,
    );
  });
});

describe("applyDeterministicRecipeEnrichers shorts outro bracket wiring", () => {
  it("runs enrichRecipeShortsOutroBracket after closure CTA step", () => {
    const recipe = buildShortRecipe({
      shortsOutroBracket: {
        enabled: true,
        text: "Koniec.",
        endAtOutputSec: 22.5,
      },
    });

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction: abstractionL1,
      timelineIndex,
      audioIndex: { clips: [{ clipId: "clip01", energyPeaks: [] }] },
      clipRegistry: recipe.clipRegistry,
      batchContext: recipe.batchContext,
    });

    const overlays = recipe.outputs[0].timeline.flatMap((seg) => seg.textOverlays ?? []);
    assert.ok(overlays.some((o) => o.overlayId === SHORT_OUTRO_BRACKET_OVERLAY_ID));
  });
});
