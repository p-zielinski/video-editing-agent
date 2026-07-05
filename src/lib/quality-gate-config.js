export const QUALITY_PROFILES = ["lenient", "production", "shorts"];

const LENIENT_GATE_CHECKS = [
  {
    code: "anchor_coverage_below_50",
    fails: (m) => m.anchorCoveragePercent < 50,
  },
  {
    code: "topic_match_rate_below_50",
    fails: (m) => m.topicMatchRate < 50,
  },
  {
    code: "l1_fields_present_below_80",
    fails: (m) => m.l1FieldsPresentPercent < 80,
  },
  {
    code: "recipe_validation_errors",
    fails: (m) => (m.validationErrorCount ?? 0) > 0,
  },
];

function maxStubCoveragePercent(stubCoverage) {
  if (!stubCoverage) {
    return 0;
  }
  return Math.max(
    stubCoverage.vision ?? 0,
    stubCoverage.audio ?? 0,
    stubCoverage.objects ?? 0,
    stubCoverage.twelvelabs ?? 0,
  );
}

function evaluateProductionGates(metrics, failures) {
  if (maxStubCoveragePercent(metrics.stubCoverage) > 0) {
    failures.push("stub_coverage_nonzero");
  }
  if ((metrics.renderFidelityErrorCount ?? 0) > 0) {
    failures.push("render_fidelity_errors");
  }
  if ((metrics.faceAnchorPercent ?? 0) < 30) {
    failures.push("face_anchor_below_30");
  }
  if (metrics.reviewApproved !== true) {
    failures.push("review_not_approved");
  }
}

function evaluateShortsGates(metrics, failures) {
  const required = metrics.minRetentionBeatsRequired ?? 0;
  const beatCount = metrics.shortRetentionBeatCount ?? metrics.retentionBeatCount ?? 0;
  if (required > 0 && beatCount < required) {
    failures.push("retention_beats_below_min");
  }
  if (metrics.hasShortOutputs && metrics.hookInFirst3s !== true) {
    failures.push("hook_missing_in_first_3s");
  }
}

/**
 * @param {object} metrics
 * @param {"lenient"|"production"|"shorts"} [profile]
 * @returns {string[]}
 */
export function evaluateQualityGates(metrics, profile = "lenient") {
  const resolved = QUALITY_PROFILES.includes(profile) ? profile : "lenient";
  const failures = [];

  for (const gate of LENIENT_GATE_CHECKS) {
    if (gate.fails(metrics)) {
      failures.push(gate.code);
    }
  }

  if (resolved === "production" || resolved === "shorts") {
    evaluateProductionGates(metrics, failures);
  }

  if (resolved === "shorts") {
    evaluateShortsGates(metrics, failures);
  }

  return failures;
}
