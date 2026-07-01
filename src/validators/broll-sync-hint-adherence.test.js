import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBrollSyncHintAdherence } from "./broll-sync-hint-adherence.js";

describe("validateBrollSyncHintAdherence", () => {
  const recipe = {
    outputs: [{
      outputId: "main",
      timeline: [{
        segmentRole: "broll",
        videoRef: { sceneId: "scene_broll_01" },
        videoInSec: 5,
      }],
    }],
  };

  it("passes when videoInSec matches hint within tolerance", () => {
    const issues = validateBrollSyncHintAdherence(recipe, {
      brollSyncHints: [{
        sceneId: "scene_broll_01",
        suggestedVideoInSec: 5.3,
        confidence: 0.85,
      }],
    });
    assert.equal(issues.length, 0);
  });

  it("warns V25-BROLL-06 when videoInSec diverges from high-confidence hint", () => {
    const issues = validateBrollSyncHintAdherence(recipe, {
      brollSyncHints: [{
        sceneId: "scene_broll_01",
        suggestedVideoInSec: 12,
        confidence: 0.9,
      }],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "V25-BROLL-06");
    assert.equal(issues[0].sceneId, "scene_broll_01");
  });

  it("ignores low-confidence hints", () => {
    const issues = validateBrollSyncHintAdherence(recipe, {
      brollSyncHints: [{
        sceneId: "scene_broll_01",
        suggestedVideoInSec: 99,
        confidence: 0.4,
      }],
    });
    assert.equal(issues.length, 0);
  });
});
