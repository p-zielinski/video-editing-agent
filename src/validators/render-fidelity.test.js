import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRenderFidelity } from "./render-fidelity.js";

function baseRecipe(overrides = {}) {
  return {
    version: "2.4",
    batchId: "batch1",
    outputs: [{
      outputId: "main_16x9",
      outputKind: "main",
      format: "16:9",
      timeline: [{
        segmentId: "seg1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 60,
        audioInSec: 0,
        audioOutSec: 60,
        audioPolicy: "from_video_ref",
        outputStartSec: 0,
        outputEndSec: 60,
        overlapSec: 0,
        speed: 1,
        syncMode: "align_start",
        cuts: [],
        timeCuts: [],
      }],
    }],
    creativeMoments: [],
    ...overrides,
  };
}

describe("validateRenderFidelity", () => {
  it("V27-RENDER-01 errors when stub/partial technique lacks reason mentioning limitation", () => {
    const recipe = baseRecipe({
      creativeMoments: [{
        momentId: "mc1",
        techniqueId: "match_cut",
        outputId: "main_16x9",
        outputStartSec: 10,
        outputEndSec: 10.3,
        reason: "Vision match between scenes",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    const issue = issues.find((i) => i.code === "V27-RENDER-01");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
  });

  it("V27-RENDER-01 passes when reason mentions stub", () => {
    const recipe = baseRecipe({
      creativeMoments: [{
        momentId: "mc1",
        techniqueId: "match_cut",
        outputId: "main_16x9",
        outputStartSec: 10,
        outputEndSec: 10.3,
        reason: "Blur stub acceptable for transition beat",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    assert.equal(issues.some((i) => i.code === "V27-RENDER-01"), false);
  });

  it("V27-RENDER-02 errors on partial crossfade in production profile", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [
          { segmentId: "s1", outputStartSec: 0, outputEndSec: 10, videoInSec: 0, videoOutSec: 10, audioInSec: 0, audioOutSec: 10 },
          { segmentId: "s2", outputStartSec: 10, outputEndSec: 20, videoInSec: 10, videoOutSec: 20, audioInSec: 10, audioOutSec: 20 },
          { segmentId: "s3", outputStartSec: 20, outputEndSec: 30, videoInSec: 20, videoOutSec: 30, audioInSec: 20, audioOutSec: 30 },
          { segmentId: "s4", outputStartSec: 30, outputEndSec: 40, videoInSec: 30, videoOutSec: 40, audioInSec: 30, audioOutSec: 40 },
        ],
      }],
      creativeMoments: [
        {
          momentId: "xf1",
          techniqueId: "crossfade",
          outputId: "main_16x9",
          outputStartSec: 10,
          outputEndSec: 10.3,
          reason: "partial crossfade stub",
        },
        {
          momentId: "xf2",
          techniqueId: "crossfade",
          outputId: "main_16x9",
          outputStartSec: 20,
          outputEndSec: 20.3,
          reason: "partial crossfade stub",
        },
      ],
    });

    const lenient = validateRenderFidelity(recipe, { qualityProfile: "lenient" });
    assert.equal(lenient.some((i) => i.code === "V27-RENDER-02"), false);

    const production = validateRenderFidelity(recipe, { qualityProfile: "production" });
    const issue = production.find((i) => i.code === "V27-RENDER-02");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
  });

  it("V27-RENDER-03 errors on unsupported syncMode + speed", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          outputStartSec: 0,
          outputEndSec: 60,
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          syncMode: "fit_video_to_audio",
          speed: 1.5,
          speedMode: "video_audio",
        }],
      }],
    });

    const issues = validateRenderFidelity(recipe);
    const issue = issues.find((i) => i.code === "V27-RENDER-03");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
  });

  it("V27-RENDER-04 warns jump_cut on J/L segment without timeCuts", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [
          {
            segmentId: "s1",
            outputStartSec: 0,
            outputEndSec: 30,
            videoInSec: 0,
            videoOutSec: 30,
            audioInSec: 0,
            audioOutSec: 30,
            audioPolicy: "from_video_ref",
            overlapSec: 0,
            timeCuts: [],
          },
          {
            segmentId: "s2",
            outputStartSec: 28,
            outputEndSec: 60,
            videoInSec: 28,
            videoOutSec: 60,
            audioInSec: 0,
            audioOutSec: 32,
            audioPolicy: "from_prev",
            overlapSec: 2,
            timeCuts: [],
          },
        ],
      }],
      creativeMoments: [{
        momentId: "jc1",
        techniqueId: "jump_cut",
        outputId: "main_16x9",
        outputStartSec: 35,
        outputEndSec: 35.15,
        reason: "partial jump on overlap",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    const issue = issues.find((i) => i.code === "V27-RENDER-04");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
  });

  it("V27-RENDER-05 warns silence_beat without cuts on segment", () => {
    const recipe = baseRecipe({
      creativeMoments: [{
        momentId: "sb1",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 12,
        outputEndSec: 12.8,
        reason: "Dead air dip only",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    const issue = issues.find((i) => i.code === "V27-RENDER-05");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
  });

  it("V27-RENDER-05 skips hard mute silence_beat without cuts on segment", () => {
    const recipe = baseRecipe({
      creativeMoments: [{
        momentId: "sb_hard",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 12,
        outputEndSec: 12.5,
        retentionRole: "hook",
        params: { durationSec: 0.5, volumeFactor: 0 },
        reason: "Hard mute pattern interrupt",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    assert.equal(issues.some((i) => i.code === "V27-RENDER-05"), false);
  });

  it("V27-RENDER-05 passes when segment has cuts", () => {
    const recipe = baseRecipe({
      outputs: [{
        outputId: "main_16x9",
        format: "16:9",
        timeline: [{
          segmentId: "seg1",
          outputStartSec: 0,
          outputEndSec: 60,
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          cuts: [{ startWordId: "clip01_w0001", endWordId: "clip01_w0005", reason: "dead_air" }],
          timeCuts: [],
        }],
      }],
      creativeMoments: [{
        momentId: "sb1",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 12,
        outputEndSec: 12.8,
        reason: "Dip before cut",
      }],
    });

    const issues = validateRenderFidelity(recipe);
    assert.equal(issues.some((i) => i.code === "V27-RENDER-05"), false);
  });
});
