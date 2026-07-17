import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryHints,
  buildEngagementRepairCandidates,
  recommendRepairs,
  summarizeDeliveryForIndex,
} from "./delivery-analysis.js";

const flatDelivery = {
  assessmentVersion: "1.0",
  mode: "heuristic",
  clipSummary: {
    engagementGrade: "flat",
    engagementScore: 0.32,
    dominantIssues: ["flat_pitch", "steady_pace"],
    flatWindowCount: 2,
    flatDeliveryWindows: [
      { startSec: 10, endSec: 15, engagementScore: 0.28, issues: ["flat_pitch"] },
      { startSec: 40, endSec: 45, engagementScore: 0.35, issues: ["steady_pace"] },
    ],
  },
};

describe("delivery-analysis", () => {
  it("summarizeDeliveryForIndex rolls up clip summary", () => {
    const rollup = summarizeDeliveryForIndex(flatDelivery);
    assert.equal(rollup.deliveryGrade, "flat");
    assert.equal(rollup.deliveryScore, 0.32);
    assert.deepEqual(rollup.deliveryDominantIssues, ["flat_pitch", "steady_pace"]);
    assert.equal(rollup.flatDeliveryWindowCount, 2);
  });

  it("recommendRepairs suggests editorial then dsp then emphasis", () => {
    const repairs = recommendRepairs(flatDelivery.clipSummary, flatDelivery.clipSummary.flatDeliveryWindows);
    assert.ok(repairs.includes("editorial_pacing"));
    assert.ok(repairs.includes("dsp_polish"));
    assert.ok(repairs.includes("localized_emphasis"));
  });

  it("buildDeliveryHints exposes flat windows and repairs", () => {
    const hints = buildDeliveryHints(flatDelivery);
    assert.equal(hints.engagementGrade, "flat");
    assert.equal(hints.flatDeliveryWindows.length, 2);
    assert.ok(hints.recommendedRepairs.length >= 2);
  });

  it("buildEngagementRepairCandidates filters flat/neutral speech clips", () => {
    const candidates = buildEngagementRepairCandidates(
      [{ clipId: "clip01", deliveryAnalysis: flatDelivery }],
      [{ clipId: "clip01", hasSpeech: true }],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].candidateId, "delivery_clip01");
    assert.ok(candidates[0].recommendedRepairs.includes("editorial_pacing"));
  });

  it("skips clips without speech", () => {
    const candidates = buildEngagementRepairCandidates(
      [{ clipId: "clip01", deliveryAnalysis: flatDelivery }],
      [{ clipId: "clip01", hasSpeech: false }],
    );
    assert.equal(candidates.length, 0);
  });
});
