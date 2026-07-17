import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePannsWindScore, finalizeAudioQuality } from "./audio-quality.js";

describe("audio-quality", () => {
  it("computePannsWindScore uses peak and coverage", () => {
    const score = computePannsWindScore([
      { editorialTag: "wind", score: 0.6, startSec: 0, endSec: 5 },
    ], 10);
    assert.ok(score >= 0.6);
  });

  it("finalizeAudioQuality merges PANNs wind and assigns candidate id", () => {
    const result = finalizeAudioQuality({
      assessmentVersion: "1.0",
      mode: "heuristic",
      hasSpeech: true,
      speechPresenceRatio: 0.2,
      estimatedSnrDb: 8,
      noiseFloorDbfs: -40,
      clippingRatio: 0,
      windScore: 0.2,
      humScore: 0.1,
      speechClarityScore: null,
      qualityScore: 0.45,
      grade: "poor",
      issues: ["low_snr"],
      confidence: 0.75,
      enhancementRecommended: true,
      reasons: ["low_snr"],
    }, {
      clipId: "clip01",
      durationSec: 30,
      hasSpeech: true,
      audioEvents: [
        { editorialTag: "wind", score: 0.7, startSec: 0, endSec: 12 },
      ],
    });

    assert.ok(result.windScore >= 0.7);
    assert.equal(result.enhancementCandidateId, "enh_clip01");
    assert.ok(result.issues.includes("wind"));
  });

  it("finalizeAudioQuality disables enhancement when clip has no speech", () => {
    const result = finalizeAudioQuality({
      grade: "poor",
      enhancementRecommended: true,
      hasSpeech: false,
      windScore: 0.8,
      issues: [],
      reasons: [],
    }, { clipId: "clip02", hasSpeech: false });

    assert.equal(result.enhancementRecommended, false);
    assert.equal(result.enhancementCandidateId, undefined);
  });
});
