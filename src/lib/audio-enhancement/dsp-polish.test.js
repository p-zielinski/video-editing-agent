import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POLISH_PRESET_FILTERS,
  resolvePolishPreset,
  shouldSkipPolishForWind,
} from "./dsp-polish.js";

describe("dsp-polish", () => {
  it("resolvePolishPreset returns filter chain for engagement_polish", () => {
    const filter = resolvePolishPreset({ polishPreset: "engagement_polish" });
    assert.ok(filter.includes("acompressor"));
    assert.ok(filter.includes("highpass"));
  });

  it("resolvePolishPreset returns null for none", () => {
    assert.equal(resolvePolishPreset({ polishPreset: "none" }), null);
  });

  it("podcast_polish matches engagement_polish chain", () => {
    assert.equal(
      POLISH_PRESET_FILTERS.podcast_polish,
      POLISH_PRESET_FILTERS.engagement_polish,
    );
  });

  it("shouldSkipPolishForWind when windScore high", () => {
    const skip = shouldSkipPolishForWind(
      [{ clipId: "c1", audioQuality: { windScore: 0.6 } }],
      "c1",
    );
    assert.equal(skip, true);
  });
});
