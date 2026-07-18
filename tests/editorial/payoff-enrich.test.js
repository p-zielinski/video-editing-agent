import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRecipePayoffMoments,
  PAYOFF_ENRICH_MOMENT_ID,
} from "../../src/editorial/payoff-enrich.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";
import { validateNarrativePayoff } from "../../src/validators/narrative.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
    { sceneId: "clip01_scene003", clipId: "clip01", startSec: 240, endSec: 360 },
  ],
};

const abstractionWithOpenLoop = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "climax" },
    { segmentId: "seg003", sceneIds: ["clip01_scene003"], startSec: 240, endSec: 360, narrativeRole: "resolution" },
  ],
  L3: {
    openLoops: [{
      loopId: "loop_01",
      kind: "cold_open",
      setupSceneId: "clip01_scene001",
      payoffSceneId: "clip01_scene002",
      teaseText: "Payoff tease",
    }],
  },
};

function buildMainRecipe(extra = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"] },
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
        cuts: [],
      }],
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("enrichRecipePayoffMoments", () => {
  it("adds enrich_payoff_001 with music_drop when open loop lacks nearby payoff", () => {
    const recipe = buildMainRecipe({
      audioMixPlan: { musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 } },
    });

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    const payoff = moments[0];
    assert.equal(payoff.momentId, PAYOFF_ENRICH_MOMENT_ID);
    assert.equal(payoff.techniqueId, "music_drop");
    assert.equal(payoff.retentionRole, "payoff");
    assert.equal(payoff.outputId, "main_16x9");
    assert.ok(Math.abs(payoff.outputStartSec - 180) <= 30);
  });

  it("uses music_swell when recipe has no musicBed", () => {
    const recipe = buildMainRecipe();

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    assert.equal(moments[0].techniqueId, "music_swell");
  });

  it("uses cut_on_beat at safe creativity level", () => {
    const recipe = buildMainRecipe({
      creativityProfile: { level: "safe" },
      audioMixPlan: { musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 } },
    });

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    assert.equal(moments[0].techniqueId, "cut_on_beat");
  });

  it("adds payoffs for each undelivered open loop", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
        { segmentId: "seg003", sceneIds: ["clip01_scene003"], startSec: 240, endSec: 360 },
      ],
      L3: {
        openLoops: [
          {
            loopId: "loop_01",
            kind: "cold_open",
            payoffSceneId: "clip01_scene002",
          },
          {
            loopId: "loop_02",
            kind: "payoff_tease",
            payoffSceneId: "clip01_scene003",
          },
        ],
      },
    };
    const recipe = buildMainRecipe();

    const moments = enrichRecipePayoffMoments(recipe, { abstraction, timelineIndex });
    const payoffs = moments.filter((m) => m.retentionRole === "payoff");
    assert.equal(payoffs.length, 2);
    assert.equal(payoffs[0].momentId, "enrich_payoff_001");
    assert.equal(payoffs[1].momentId, "enrich_payoff_002");
  });

  it("skips when retentionRole payoff already exists within tolerance", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: "director_payoff",
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 175,
        outputEndSec: 178,
        retentionRole: "payoff",
        reason: "Director payoff",
        confidence: 0.8,
      }],
    });

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
    assert.equal(moments[0].momentId, "director_payoff");
  });

  it("is idempotent when enrich_payoff_001 already exists", () => {
    const recipe = buildMainRecipe({
      creativeMoments: [{
        momentId: PAYOFF_ENRICH_MOMENT_ID,
        techniqueId: "music_drop",
        outputId: "main_16x9",
        outputStartSec: 180,
        outputEndSec: 183,
        retentionRole: "payoff",
        reason: "Already enriched",
        confidence: 0.7,
      }],
    });

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    assert.equal(moments.length, 1);
  });

  it("adds payoff for L2 climax when openLoops absent", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "climax" },
      ],
      L3: { narrativeArc: "intro → climax" },
    };
    const recipe = buildMainRecipe();

    const moments = enrichRecipePayoffMoments(recipe, { abstraction, timelineIndex });

    assert.equal(moments.length, 1);
    assert.equal(moments[0].momentId, PAYOFF_ENRICH_MOMENT_ID);
    assert.match(moments[0].reason, /l2:climax/);
  });

  it("skips payoff in slow/breath L2 with silencePolicy preserve", () => {
    const abstraction = {
      L2: [
        {
          segmentId: "seg_breath",
          sceneIds: ["clip01_scene002"],
          startSec: 120,
          endSec: 240,
          narrativeRole: "breath",
        },
      ],
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "callback",
          payoffSceneId: "clip01_scene002",
        }],
      },
    };
    const recipe = buildMainRecipe({
      narrativeProfile: {
        segments: [{
          l2SegmentId: "seg_breath",
          rhythm: "slow",
          retentionIntensity: "low",
          silencePolicy: "preserve",
        }],
      },
    });

    const moments = enrichRecipePayoffMoments(recipe, { abstraction, timelineIndex });
    assert.equal(moments.length, 0);
  });

  it("adds payoff candidate from emotionalBeatHints", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
      ],
      L3: { narrativeArc: "intro" },
    };
    const recipe = buildMainRecipe();

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction,
      timelineIndex,
      emotionalBeatHints: [{
        sceneId: "clip01_scene002",
        anchorTimeSec: 180,
        mood: "dramatic",
        retentionRole: "payoff",
      }],
    });

    assert.equal(moments.length, 1);
    assert.match(moments[0].reason, /emotionalBeat/);
  });

  it("maps emotionalBeatHints via sceneId when anchorTimeSec is omitted", () => {
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
      ],
      L3: { narrativeArc: "intro" },
    };
    const recipe = buildMainRecipe();

    const moments = enrichRecipePayoffMoments(recipe, {
      abstraction,
      timelineIndex,
      emotionalBeatHints: [{
        sceneId: "clip01_scene002",
        clipId: "clip01",
        mood: "dramatic",
        retentionRole: "payoff",
      }],
    });

    assert.equal(moments.length, 1);
    assert.match(moments[0].reason, /emotionalBeat/);
    assert.ok(Math.abs(moments[0].outputStartSec - 180) <= 30);
  });

  it("clears NAR-PAYOFF-UNDELIVERED for structural open loop", () => {
    const recipe = buildMainRecipe({
      audioMixPlan: { musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 } },
    });

    enrichRecipePayoffMoments(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });

    const issues = validateNarrativePayoff(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
    });
    assert.equal(issues.length, 0);
  });
});

describe("applyDeterministicRecipeEnrichers payoff integration", () => {
  it("adds enrich_payoff_001 after retention beats and before chapter cards", () => {
    const recipe = buildMainRecipe({
      vlogRetentionProfile: { enabled: true, beatIntervalSec: 45, beatToleranceSec: 8 },
      audioMixPlan: { musicBed: { trackId: "bed_01", volumeDb: -18, duckingDb: -12 } },
    });

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction: abstractionWithOpenLoop,
      timelineIndex,
      audioIndex: { clips: [{ clipId: "clip01", energyPeaks: [] }] },
      clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
      batchContext: { brollStrategy: "minimal" },
    });

    const payoffMoments = (recipe.creativeMoments ?? []).filter(
      (moment) => moment.momentId === PAYOFF_ENRICH_MOMENT_ID,
    );
    assert.equal(payoffMoments.length, 1);

    const enrichPayoffCount = (recipe.creativeMoments ?? []).filter(
      (moment) => moment.momentId === PAYOFF_ENRICH_MOMENT_ID,
    ).length;
    assert.equal(enrichPayoffCount, 1);
  });
});
