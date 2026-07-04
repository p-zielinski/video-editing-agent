import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateClosureCta,
  CLOSURE_CTA_VALIDATOR_CODE,
} from "./closure-cta.js";

const abstractionResolution = {
  L2: [
    { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
    { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240, narrativeRole: "resolution" },
  ],
};

function longMainRecipe({ durationSec = 120, overlays = [], extra = {} } = {}) {
  return {
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: durationSec,
        audioInSec: 0,
        audioOutSec: durationSec,
        audioPolicy: "from_video_ref",
        textOverlays: overlays,
      }],
    }],
    batchContext: { requiredFormats: ["16:9"] },
    ...extra,
  };
}

describe("validateClosureCta", () => {
  it("warns V26-CTA-01 for internet_documentary main >=60s without tail CTA", () => {
    const recipe = longMainRecipe({
      extra: { narrativeProfile: { mode: "internet_documentary" } },
    });

    const issues = validateClosureCta(recipe, { abstraction: abstractionResolution });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, CLOSURE_CTA_VALIDATOR_CODE);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].outputId, "main_16x9");
  });

  it("warns V26-CTA-01 when final L2 is resolution without tail CTA", () => {
    const issues = validateClosureCta(longMainRecipe(), { abstraction: abstractionResolution });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, CLOSURE_CTA_VALIDATOR_CODE);
  });

  it("passes when CTA overlay exists in last 15s", () => {
    const recipe = longMainRecipe({
      overlays: [{
        overlayId: "dir_cta_1",
        text: "Subscribe",
        outputStartSec: 110,
        outputEndSec: 120,
        style: "cta",
        role: "cta",
      }],
      extra: { narrativeProfile: { mode: "internet_documentary" } },
    });

    const issues = validateClosureCta(recipe, { abstraction: abstractionResolution });

    assert.equal(issues.length, 0);
  });

  it("skips when main duration is under 60s", () => {
    const recipe = longMainRecipe({
      durationSec: 59,
      extra: { narrativeProfile: { mode: "internet_documentary" } },
    });

    const issues = validateClosureCta(recipe, { abstraction: abstractionResolution });

    assert.equal(issues.length, 0);
  });
});
