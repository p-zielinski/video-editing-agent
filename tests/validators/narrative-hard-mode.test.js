import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NAR_HARD_MODE_CODES,
  resolveNarrativeIssueSeverity,
  validateNarrativeBeatSpam,
  validateNarrativeBreathBeat,
  validateNarrativePayoff,
  validateNarrativePayoffMissing,
} from "../../src/validators/narrative.js";

const timelineIndex = {
  scenes: [
    { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
    { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
  ],
};

const abstraction = {
  L2: [
    {
      segmentId: "seg001",
      sceneIds: ["clip01_scene001"],
      startSec: 0,
      endSec: 120,
      narrativeRole: "breath",
    },
    {
      segmentId: "seg002",
      sceneIds: ["clip01_scene002"],
      startSec: 120,
      endSec: 240,
      narrativeRole: "climax",
    },
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
    clipRegistry: [{ clipId: "clip01", durationSec: 240 }],
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
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
        cuts: [],
      }],
    }],
    creativeMoments: [],
    ...extra,
  };
}

describe("resolveNarrativeIssueSeverity", () => {
  it("keeps default severity outside internet_documentary mode", () => {
    assert.equal(
      resolveNarrativeIssueSeverity("NAR-BEAT-SPAM", { mode: "retention_vlog" }, "warning"),
      "warning",
    );
    assert.equal(
      resolveNarrativeIssueSeverity("NAR-BEAT-SPAM", null, "warning"),
      "warning",
    );
  });

  it("promotes NAR_HARD_MODE_CODES to error in internet_documentary mode", () => {
    for (const code of NAR_HARD_MODE_CODES) {
      assert.equal(
        resolveNarrativeIssueSeverity(code, { mode: "internet_documentary" }, "warning"),
        "error",
        `expected ${code} to hard-fail`,
      );
    }
  });

  it("leaves non-hard codes unchanged in internet_documentary mode", () => {
    assert.equal(
      resolveNarrativeIssueSeverity("NAR-PACING-TRIM-EXHAUSTED", { mode: "internet_documentary" }, "warning"),
      "warning",
    );
  });
});

describe("internet_documentary hard mode validators", () => {
  it("NAR-PAYOFF-UNDELIVERED is error in internet_documentary mode", () => {
    const issues = validateNarrativePayoff(buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
    }), { abstraction, timelineIndex });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-UNDELIVERED");
    assert.equal(issues[0].severity, "error");
  });

  it("NAR-PAYOFF-UNDELIVERED stays warning in retention_vlog mode", () => {
    const issues = validateNarrativePayoff(buildMainRecipe({
      narrativeProfile: { mode: "retention_vlog" },
    }), { abstraction, timelineIndex });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "warning");
  });

  it("NAR-PAYOFF-MISSING is error in internet_documentary mode", () => {
    const issues = validateNarrativePayoffMissing(buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
    }), { abstraction });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-PAYOFF-MISSING");
    assert.equal(issues[0].severity, "error");
  });

  it("NAR-BREATH-BEAT is error in internet_documentary mode", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: { mode: "internet_documentary" },
      creativeMoments: [{
        momentId: "beat_breath",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 30,
        outputEndSec: 32,
        retentionRole: "beat",
        reason: "Beat in breath",
        confidence: 0.7,
      }],
    });

    const issues = validateNarrativeBreathBeat(recipe, { abstraction });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "NAR-BREATH-BEAT");
    assert.equal(issues[0].severity, "error");
  });

  it("NAR-BEAT-SPAM is error in internet_documentary mode", () => {
    const recipe = buildMainRecipe({
      narrativeProfile: {
        mode: "internet_documentary",
        segments: [{ l2SegmentId: "seg001", rhythm: "slow", retentionIntensity: "low" }],
      },
      creativeMoments: [
        {
          momentId: "enrich_beat_001",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 20,
          outputEndSec: 22,
          retentionRole: "beat",
          reason: "Enriched beat",
          confidence: 0.7,
        },
        {
          momentId: "enrich_beat_002",
          techniqueId: "zoom_slow_push",
          outputId: "main_16x9",
          outputStartSec: 40,
          outputEndSec: 42,
          retentionRole: "beat",
          reason: "Enriched beat 2",
          confidence: 0.7,
        },
      ],
    });

    const issues = validateNarrativeBeatSpam(recipe, { abstraction });
    assert.ok(issues.some((issue) => issue.code === "NAR-BEAT-SPAM"));
    assert.ok(issues.every((issue) => issue.severity === "error"));
  });
});
