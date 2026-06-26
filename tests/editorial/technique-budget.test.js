import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeCreativityBudget,
  computeDurationTuning,
  meetsCreativityLevel,
  mergeCreativityProfile,
  parseCreativityFromContext,
} from "../../src/editorial/technique-budget.js";

describe("technique-budget", () => {
  it("computeDurationTuning matches ~1 zoom per 6 min for 15 min", () => {
    const tuning = computeDurationTuning(15 * 60);
    assert.equal(tuning.maxZoomMoments, 3);
    assert.ok(tuning.minZoomGapSec >= 30);
    assert.ok(tuning.maxTotalZoomDutySec < 15 * 60 * 0.02);
  });

  it("balanced 15 min budget allows 3 zoom moments", () => {
    const budget = computeCreativityBudget(15 * 60, { level: "balanced" });
    assert.equal(budget.maxZoomMoments, 3);
    assert.equal(budget.allowMidSentenceCuts, false);
  });

  it("safe level reduces zoom budget", () => {
    const balanced = computeCreativityBudget(15 * 60, { level: "balanced" });
    const safe = computeCreativityBudget(15 * 60, { level: "safe" });
    assert.ok(safe.maxZoomMoments < balanced.maxZoomMoments);
    assert.ok(safe.minZoomGapSec > balanced.minZoomGapSec);
  });

  it("shorts level doubles density", () => {
    const balanced = computeCreativityBudget(10 * 60, { level: "balanced" });
    const shorts = computeCreativityBudget(10 * 60, { level: "shorts" });
    assert.ok(shorts.maxZoomMoments > balanced.maxZoomMoments);
    assert.ok(shorts.maxTotalTechniqueMoments > balanced.maxTotalTechniqueMoments);
    assert.equal(shorts.allowMidSentenceCuts, false);
  });

  it("parseCreativityFromContext reads creativity: bold", () => {
    const profile = parseCreativityFromContext("vlog dzień 66, creativity: bold");
    assert.equal(profile.level, "bold");
    assert.equal(profile.allowMidSentenceCuts, true);
  });

  it("parseCreativityFromContext reads shorts: energy high", () => {
    const profile = parseCreativityFromContext("shorts: energy high");
    assert.equal(profile.level, "shorts");
    assert.equal(profile.techniquePack, "shorts_energy");
  });

  it("mergeCreativityProfile auto-sets allowMidSentenceCuts for bold unless explicitly false", () => {
    const bold = mergeCreativityProfile({ level: "bold" });
    assert.equal(bold.allowMidSentenceCuts, true);

    const boldOff = mergeCreativityProfile({ level: "bold", allowMidSentenceCuts: false });
    assert.equal(boldOff.allowMidSentenceCuts, false);
  });

  it("mergeCreativityProfile reads defaultCreativityLevel from pack", () => {
    const profile = mergeCreativityProfile({}, { defaultCreativityLevel: "shorts" });
    assert.equal(profile.level, "shorts");
    assert.equal(profile.allowMidSentenceCuts, true);
  });

  it("meetsCreativityLevel uses ordered comparison", () => {
    assert.equal(meetsCreativityLevel("balanced", "bold"), false);
    assert.equal(meetsCreativityLevel("bold", "bold"), true);
    assert.equal(meetsCreativityLevel("shorts", "bold"), true);
  });
});
