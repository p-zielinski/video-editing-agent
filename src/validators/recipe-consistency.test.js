import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateRecipeConsistency,
  runConsistencyAuditor,
} from "./recipe-consistency.js";
import { sanitizeRecipeConsistency } from "../editorial/recipe-consistency-sanitize.js";

function baseSegment(overrides = {}) {
  return {
    segmentId: "s1",
    segmentRole: "aroll",
    videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
    audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
    videoInSec: 0,
    videoOutSec: 10,
    audioInSec: 0,
    audioOutSec: 10,
    audioPolicy: "from_video_ref",
    textOverlays: [],
    ...overrides,
  };
}

function minimalRecipe({ timeline, outputId = "main_16x9", ...extra } = {}) {
  return {
    outputs: [{
      outputId,
      outputKind: "main",
      format: "16:9",
      timeline: timeline ?? [baseSegment()],
    }],
    ...extra,
  };
}

describe("recipe-consistency", () => {
  it("detects CONS-TL-01 invalid overlay range", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        textOverlays: [{
          overlayId: "bad_overlay",
          text: "Hello",
          outputStartSec: 5,
          outputEndSec: 5,
        }],
      })],
    });

    const issues = validateRecipeConsistency(recipe);
    assert.ok(issues.some((issue) => issue.code === "CONS-TL-01"));
  });

  it("detects CONS-TX-01 empty overlay text and sanitize drops it", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        textOverlays: [{
          overlayId: "empty_overlay",
          text: "   ",
          outputStartSec: 1,
          outputEndSec: 3,
        }],
      })],
    });

    const before = validateRecipeConsistency(recipe);
    assert.ok(before.some((issue) => issue.code === "CONS-TX-01"));

    const fixes = sanitizeRecipeConsistency(recipe);
    assert.ok(fixes.some((fix) => fix.action === "drop_empty_overlay"));
    assert.equal(recipe.outputs[0].timeline[0].textOverlays.length, 0);

    const after = validateRecipeConsistency(recipe);
    assert.equal(after.filter((issue) => issue.code === "CONS-TX-01").length, 0);
  });

  it("detects CONS-TX-02 duplicate overlays with high overlap", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        textOverlays: [
          {
            overlayId: "dup_a",
            text: "Same Text",
            outputStartSec: 1,
            outputEndSec: 5,
            role: "hook",
          },
          {
            overlayId: "dup_b",
            text: "same text",
            outputStartSec: 1.2,
            outputEndSec: 4.8,
            role: "retention_beat",
          },
        ],
      })],
    });

    const issues = validateRecipeConsistency(recipe);
    assert.ok(issues.some((issue) => issue.code === "CONS-TX-02"));

    sanitizeRecipeConsistency(recipe);
    assert.equal(recipe.outputs[0].timeline[0].textOverlays.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].textOverlays[0].overlayId, "dup_a");
  });

  it("sanitizes CONS-LAY-02 by moving bottom overlay to top_center", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        subtitles: {
          policy: "phrase",
          sourceClipId: "clip01",
        },
        textOverlays: [{
          overlayId: "dir_hook_1",
          text: "Big Hook",
          outputStartSec: 1,
          outputEndSec: 4,
          style: "cta",
          role: "cta",
          position: "bottom_center",
        }],
      })],
    });

    const before = validateRecipeConsistency(recipe);
    assert.ok(before.some((issue) => issue.code === "CONS-LAY-02"));

    const fixes = sanitizeRecipeConsistency(recipe);
    const overlay = recipe.outputs[0].timeline[0].textOverlays[0];
    assert.equal(overlay.position, "top_center");
    assert.ok(fixes.some((fix) => fix.action === "move_overlay_band"));

    const after = validateRecipeConsistency(recipe);
    assert.equal(after.filter((issue) => issue.code === "CONS-LAY-02").length, 0);
  });

  it("runConsistencyAuditor approves after sanitize for layout conflict case", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        subtitles: {
          policy: "word_by_word",
          sourceClipId: "clip01",
        },
        textOverlays: [{
          overlayId: "dir_hook_1",
          text: "Hook line",
          outputStartSec: 2,
          outputEndSec: 5,
          style: "emphasis",
          position: "bottom_center",
        }],
      })],
    });

    const result = runConsistencyAuditor(recipe);
    assert.ok(result.fixes.length > 0);
    assert.equal(result.approved, true);
    assert.equal(result.issues.filter((issue) => issue.severity === "error").length, 0);
  });

  it("warns CONS-TL-02 for unexpected gap between segments", () => {
    const recipe = minimalRecipe({
      timeline: [
        baseSegment({
          segmentId: "s1",
          outputStartSec: 0,
          outputEndSec: 10,
        }),
        baseSegment({
          segmentId: "s2",
          videoInSec: 10,
          videoOutSec: 20,
          audioInSec: 10,
          audioOutSec: 20,
          outputStartSec: 10.2,
          outputEndSec: 20,
        }),
      ],
    });

    const issues = validateRecipeConsistency(recipe);
    const gapIssue = issues.find((issue) => issue.code === "CONS-TL-02");
    assert.ok(gapIssue);
    assert.equal(gapIssue.severity, "warning");
  });

  it("drops only one duplicate when overlayId is missing", () => {
    const recipe = minimalRecipe({
      timeline: [baseSegment({
        textOverlays: [
          {
            text: "Same",
            outputStartSec: 1,
            outputEndSec: 4,
            role: "hook",
          },
          {
            text: "same",
            outputStartSec: 1.1,
            outputEndSec: 3.9,
            role: "cta",
          },
        ],
      })],
    });

    sanitizeRecipeConsistency(recipe);
    assert.equal(recipe.outputs[0].timeline[0].textOverlays.length, 1);
    assert.equal(recipe.outputs[0].timeline[0].textOverlays[0].role, "hook");
  });

  it("sanitizes cross-segment CONS-LAY-02 overlay vs subtitle band collision", () => {
    const recipe = minimalRecipe({
      timeline: [
        baseSegment({
          segmentId: "s1",
          outputStartSec: 0,
          outputEndSec: 10,
          subtitles: { policy: "phrase", sourceClipId: "clip01" },
        }),
        baseSegment({
          segmentId: "s2",
          videoInSec: 10,
          videoOutSec: 20,
          audioInSec: 10,
          audioOutSec: 20,
          outputStartSec: 8,
          outputEndSec: 18,
          overlapSec: 2,
          textOverlays: [{
            overlayId: "cross_cta",
            text: "CTA",
            outputStartSec: 8.5,
            outputEndSec: 11,
            style: "cta",
            role: "cta",
            position: "bottom_center",
          }],
        }),
      ],
    });

    const before = validateRecipeConsistency(recipe);
    assert.ok(before.some((issue) => issue.code === "CONS-LAY-02"));

    const result = runConsistencyAuditor(recipe);
    assert.ok(result.fixes.some((fix) => fix.code === "CONS-LAY-02"));
    assert.equal(result.issues.filter((issue) => issue.code === "CONS-LAY-02").length, 0);
  });
});
