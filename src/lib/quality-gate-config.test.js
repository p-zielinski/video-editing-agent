import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityGates } from "./quality-gate-config.js";

function passingMetrics(overrides = {}) {
  return {
    anchorCoveragePercent: 80,
    topicMatchRate: 80,
    l1FieldsPresentPercent: 90,
    validationErrorCount: 0,
    stubCoverage: { vision: 0, audio: 0, objects: 0, twelvelabs: 0 },
    renderFidelityErrorCount: 0,
    faceAnchorPercent: 50,
    reviewApproved: true,
    retentionBeatCount: 3,
    shortRetentionBeatCount: 3,
    minRetentionBeatsRequired: 2,
    hookInFirst3s: true,
    hasShortOutputs: true,
    briefSceneMapCoverage: null,
    superPath: false,
    superCriticApproved: null,
    sceneCount: 5,
    timelineSceneCount: 5,
    ...overrides,
  };
}

describe("quality_gate_config", () => {
  it("lenient profile applies only the four legacy gates", () => {
    assert.deepEqual(evaluateQualityGates(passingMetrics(), "lenient"), []);
    assert.deepEqual(
      evaluateQualityGates(passingMetrics({ anchorCoveragePercent: 10 }), "lenient"),
      ["anchor_coverage_below_50"],
    );
    assert.deepEqual(
      evaluateQualityGates(passingMetrics({
        faceAnchorPercent: 0,
        reviewApproved: false,
        stubCoverage: { vision: 100, audio: 0, objects: 0, twelvelabs: 0 },
      }), "lenient"),
      [],
    );
  });

  it("production profile adds stub, render fidelity, face anchor, and review gates", () => {
    assert.deepEqual(evaluateQualityGates(passingMetrics(), "production"), []);

    const failures = evaluateQualityGates(passingMetrics({
      stubCoverage: { vision: 0, audio: 50, objects: 0, twelvelabs: 0 },
      renderFidelityErrorCount: 1,
      faceAnchorPercent: 10,
      reviewApproved: false,
    }), "production");

    assert.deepEqual(failures, [
      "stub_coverage_nonzero",
      "render_fidelity_errors",
      "face_anchor_below_30",
      "review_not_approved",
    ]);
  });

  it("production fails when review is missing", () => {
    assert.deepEqual(
      evaluateQualityGates(passingMetrics({ reviewApproved: null }), "production"),
      ["review_not_approved"],
    );
  });

  it("production fails super_critic_not_approved when super path critic rejects", () => {
    const failures = evaluateQualityGates(passingMetrics({
      superPath: true,
      superCriticApproved: false,
    }), "production");
    assert.ok(failures.includes("super_critic_not_approved"));
  });

  it("production skips super_critic gate when super critic review is absent", () => {
    const failures = evaluateQualityGates(passingMetrics({
      superPath: true,
      superCriticApproved: null,
    }), "production");
    assert.ok(!failures.includes("super_critic_not_approved"));
  });

  it("production fails brief_scene_map_coverage_low on non-super path with low coverage", () => {
    const failures = evaluateQualityGates(passingMetrics({
      superPath: false,
      briefSceneMapCoverage: 0.3,
      timelineSceneCount: 40,
    }), "production");
    assert.ok(failures.includes("brief_scene_map_coverage_low"));
  });

  it("production skips brief_scene_map_coverage_low when scene count is small", () => {
    const failures = evaluateQualityGates(passingMetrics({
      superPath: false,
      briefSceneMapCoverage: 0.3,
      timelineSceneCount: 30,
    }), "production");
    assert.ok(!failures.includes("brief_scene_map_coverage_low"));
  });

  it("shorts profile adds retention beat and hook gates on top of production", () => {
    assert.deepEqual(evaluateQualityGates(passingMetrics(), "shorts"), []);

    const failures = evaluateQualityGates(passingMetrics({
      shortRetentionBeatCount: 0,
      minRetentionBeatsRequired: 2,
      hookInFirst3s: false,
    }), "shorts");

    assert.ok(failures.includes("retention_beats_below_min"));
    assert.ok(failures.includes("hook_missing_in_first_3s"));
    assert.ok(failures.includes("review_not_approved") === false);
  });

  it("shorts hook gate is skipped when recipe has no short outputs", () => {
    const failures = evaluateQualityGates(passingMetrics({
      hasShortOutputs: false,
      hookInFirst3s: false,
      shortRetentionBeatCount: 0,
      minRetentionBeatsRequired: 0,
    }), "shorts");

    assert.ok(!failures.includes("hook_missing_in_first_3s"));
    assert.ok(!failures.includes("retention_beats_below_min"));
  });

  it("falls back to lenient for unknown profile names", () => {
    assert.deepEqual(
      evaluateQualityGates(passingMetrics({ topicMatchRate: 10 }), "unknown"),
      ["topic_match_rate_below_50"],
    );
  });
});
