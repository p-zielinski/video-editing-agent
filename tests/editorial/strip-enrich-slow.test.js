import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripEnrichBeatsInSlowSegments } from "../../src/editorial/shorts-retention.js";
import { applyDeterministicRecipeEnrichers } from "../../src/pipeline/steps/agents.js";
import { DEFAULT_VLOG_RETENTION_PROFILE } from "../../src/editorial/shorts-retention.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 180 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 180, endSec: 360 },
  ],
};

const abstraction = {
  L2: [
    { segmentId: "seg_fast", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 180, narrativeRole: "tension" },
    { segmentId: "seg_breath", sceneIds: ["clip01_scene002"], startSec: 180, endSec: 360, narrativeRole: "breath" },
  ],
};

function buildMainRecipe(creativeMoments = []) {
  return {
    version: "2.4",
    batchId: "batch1",
    batchContext: { requiredFormats: ["16:9"], brollStrategy: "minimal" },
    clipRegistry: [{ clipId: "clip01", durationSec: 360 }],
    narrativeProfile: {
      segments: [
        { l2SegmentId: "seg_fast", rhythm: "fast", retentionIntensity: "high" },
        { l2SegmentId: "seg_breath", rhythm: "slow", retentionIntensity: "low", silencePolicy: "preserve" },
      ],
    },
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
    vlogRetentionProfile: { ...DEFAULT_VLOG_RETENTION_PROFILE, enabled: true },
    creativeMoments,
    sfxPlan: [],
  };
}

describe("stripEnrichBeatsInSlowSegments", () => {
  it("removes enrich_beat_* inside breath L2 output range", () => {
    const recipe = buildMainRecipe([
      {
        momentId: "enrich_beat_001",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 30,
        outputEndSec: 33,
        retentionRole: "beat",
      },
      {
        momentId: "enrich_beat_002",
        techniqueId: "ken_burns_light",
        outputId: "main_16x9",
        outputStartSec: 200,
        outputEndSec: 203,
        retentionRole: "beat",
      },
      {
        momentId: "cm_director_beat",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 210,
        outputEndSec: 213,
        retentionRole: "beat",
      },
    ]);

    const filtered = stripEnrichBeatsInSlowSegments(recipe, abstraction);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.some((m) => m.momentId === "enrich_beat_001"));
    assert.ok(!filtered.some((m) => m.momentId === "enrich_beat_002"));
    assert.ok(filtered.some((m) => m.momentId === "cm_director_beat"));
  });

  it("preserves enrich beats when no slow/breath L2 ranges match", () => {
    const recipe = buildMainRecipe([
      {
        momentId: "enrich_beat_001",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 30,
        outputEndSec: 33,
        retentionRole: "beat",
      },
    ]);

    const filtered = stripEnrichBeatsInSlowSegments(recipe, {
      L2: [{ segmentId: "seg_fast", startSec: 0, endSec: 360, narrativeRole: "tension" }],
    });
    assert.equal(filtered.length, 1);
  });
});

describe("applyDeterministicRecipeEnrichers strip integration", () => {
  it("strips misplaced enrich beats before adding new ones", () => {
    const recipe = buildMainRecipe([
      {
        momentId: "enrich_beat_001",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 200,
        outputEndSec: 203,
        retentionRole: "beat",
      },
    ]);

    const audioIndex = {
      clips: [{
        clipId: "clip01",
        energyPeaks: [
          { startSec: 39, endSec: 41, rmsDb: -12 },
          { startSec: 84, endSec: 88, rmsDb: -10 },
        ],
      }],
    };

    applyDeterministicRecipeEnrichers(recipe, {
      abstraction,
      timelineIndex,
      audioIndex,
      clipRegistry: recipe.clipRegistry,
      batchContext: { brollStrategy: "minimal" },
    });

    const breathEnrichBeats = (recipe.creativeMoments ?? []).filter(
      (m) => (m.momentId ?? "").startsWith("enrich_beat_")
        && (m.outputStartSec ?? 0) >= 180,
    );
    assert.equal(breathEnrichBeats.length, 0);
  });
});
