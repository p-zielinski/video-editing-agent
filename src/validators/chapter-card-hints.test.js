import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateChapterCardHintCoverage,
  CHAPTER_CARD_VALIDATOR_CODE,
  CHAPTER_CARD_MIN_DURATION_SEC,
} from "./chapter-card-hints.js";

function longMainRecipe({ durationSec = 300, overlays = [] } = {}) {
  return {
    version: "2.0",
    batchId: "test",
    batchContext: { inputMode: "multi_clip_day", requiredFormats: ["16:9"] },
    clipRegistry: [{
      clipId: "clip01",
      fileName: "a.mov",
      durationSec,
      sortIndex: 0,
      clipRole: "aroll_primary",
      hasSpeech: true,
    }],
    outputs: [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
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
    excluded: [],
    sceneUsageRegistry: [],
  };
}

function chapterCardOverlay(outputStartSec) {
  return {
    overlayId: "dir_chapter_1",
    text: "Part 2",
    outputStartSec,
    outputEndSec: outputStartSec + 4,
    style: "chapter_card",
  };
}

describe("validateChapterCardHintCoverage", () => {
  it("warns V26-CHAPTER-01 when hint at 120s has no nearby chapter_card overlay", () => {
    const recipe = longMainRecipe();
    const hints = [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe, { chapterCardHints: hints });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, CHAPTER_CARD_VALIDATOR_CODE);
    assert.equal(issues[0].severity, "warning");
    assert.equal(issues[0].outputId, "main_16x9");
    assert.match(issues[0].message, /120s/);
  });

  it("passes when chapter_card overlay at 118s covers hint at 120s", () => {
    const recipe = longMainRecipe({ overlays: [chapterCardOverlay(118)] });
    const hints = [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe, { chapterCardHints: hints });

    assert.equal(issues.length, 0);
  });

  it("reads chapterCardHints embedded on recipe when options omitted", () => {
    const recipe = longMainRecipe();
    recipe.chapterCardHints = [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe);

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, CHAPTER_CARD_VALIDATOR_CODE);
  });

  it("skips validation when main duration is under 180s", () => {
    const recipe = longMainRecipe({ durationSec: CHAPTER_CARD_MIN_DURATION_SEC - 1 });
    const hints = [{ outputId: "main_16x9", targetSec: 60, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe, { chapterCardHints: hints });

    assert.equal(issues.length, 0);
  });

  it("ignores hints for non-main outputId", () => {
    const recipe = longMainRecipe();
    const hints = [{ outputId: "short_9x16", targetSec: 120, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe, { chapterCardHints: hints });

    assert.equal(issues.length, 0);
  });

  it("does not treat role chapter without style chapter_card as coverage", () => {
    const recipe = longMainRecipe({
      overlays: [{
        overlayId: "emphasis_1",
        text: "Chapter",
        outputStartSec: 118,
        outputEndSec: 122,
        style: "emphasis",
        role: "chapter",
      }],
    });
    const hints = [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }];

    const issues = validateChapterCardHintCoverage(recipe, { chapterCardHints: hints });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, CHAPTER_CARD_VALIDATOR_CODE);
  });
});
