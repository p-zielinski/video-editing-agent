import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findSubstantiveWordStartSec,
  isGreetingWord,
  segmentOpensWithGreeting,
  shortSegmentStartsWithIntro,
} from "../../src/editorial/shorts-greeting.js";
import { enrichRecipeShortIntroSkip } from "../../src/editorial/shorts-intro-skip.js";
import { computeSceneRank } from "../../src/editorial/scene-rank.js";
import { computeCreativityBudgetForRecipe } from "../../src/editorial/technique-budget.js";
import { resolveShortRetentionInterval } from "../../src/editorial/shorts-retention.js";
import { snapToNearestMusicBeat } from "../../src/lib/music-beat-grid.js";
import { enrichRecipeMusicBeatSnap } from "../../src/editorial/music-beat-snap.js";
import { validateShortsRetention } from "../../src/validators/shorts-retention.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";

describe("shorts-greeting", () => {
  it("detects greeting words", () => {
    assert.equal(isGreetingWord("Hej"), true);
    assert.equal(isGreetingWord("explozja"), false);
  });

  it("finds substantive word after greeting", () => {
    const wordIndex = {
      words: [
        { word: "Hej", start: 0, end: 0.3, isFiller: false },
        { word: "co", start: 0.35, end: 0.5, isFiller: false },
        { word: "tam", start: 0.55, end: 0.8, isFiller: false },
        { word: "wybuchło", start: 1.0, end: 1.5, isFiller: false },
      ],
    };
    assert.equal(findSubstantiveWordStartSec(wordIndex, 0), 1.0);
    assert.equal(segmentOpensWithGreeting(wordIndex, 0), true);
  });
});

describe("enrichRecipeShortIntroSkip", () => {
  it("trims greeting opening to substantive inpoint", () => {
    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        timeline: [{
          segmentId: "s1",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 10,
          audioInSec: 0,
          audioOutSec: 10,
        }],
      }],
    };
    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { word: "Hej", start: 0, end: 0.3, isFiller: false },
        { word: "wybuchło", start: 1.0, end: 1.5, isFiller: false },
      ],
    }];

    enrichRecipeShortIntroSkip(recipe, { wordIndexes });
    assert.equal(recipe.outputs[0].timeline[0].audioInSec, 1);
    assert.equal(recipe.shortsIntroSkipMeta.strategy, "mid_sentence_inpoint");
  });
});

describe("scene-rank intro penalty", () => {
  it("ranks tension scene above setup greeting opener", () => {
    const timelineIndex = {
      scenes: [
        { sceneId: "s1", clipId: "c1", startSec: 0, endSec: 10, hasSpeech: true },
        { sceneId: "s2", clipId: "c1", startSec: 10, endSec: 20, hasSpeech: true },
      ],
      words: [
        { word: "Hej", start: 0.2, end: 0.5, isFiller: false },
        { word: "wow", start: 12, end: 12.5, isFiller: false },
      ],
    };
    const abstraction = {
      L1: [
        { sceneId: "s1", visualQuality: "high" },
        { sceneId: "s2", visualQuality: "high" },
      ],
      L2: [
        { segmentId: "l2_1", narrativeRole: "setup", sceneIds: ["s1"] },
        { segmentId: "l2_2", narrativeRole: "tension", sceneIds: ["s2"] },
      ],
    };

    const setupRank = computeSceneRank(timelineIndex.scenes[0], abstraction.L1[0], timelineIndex, { abstraction });
    const tensionRank = computeSceneRank(timelineIndex.scenes[1], abstraction.L1[1], timelineIndex, { abstraction });
    assert.ok(tensionRank > setupRank);
  });
});

describe("short creativity auto-elevate", () => {
  it("uses shorts level budget for 9:16 output when retention applies", () => {
    const recipe = {
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      outputs: [
        { outputId: "main_16x9", outputKind: "main", format: "16:9", timeline: [{ outputEndSec: 600 }] },
        { outputId: "short_9x16", outputKind: "short", format: "9:16", timeline: [{ outputEndSec: 45 }] },
      ],
    };
    const { byOutputId } = computeCreativityBudgetForRecipe(recipe, { level: "balanced" });
    assert.equal(byOutputId.main_16x9.level, "balanced");
    assert.equal(byOutputId.short_9x16.level, "shorts");
    assert.equal(byOutputId.short_9x16.allowMidSentenceCuts, true);
    assert.ok(byOutputId.short_9x16.maxTechniqueDensityPerMin > byOutputId.main_16x9.maxTechniqueDensityPerMin);
  });
});

describe("resolveShortRetentionInterval", () => {
  it("uses denser cadence for reels <=45s", () => {
    assert.equal(resolveShortRetentionInterval({}, 40), 10);
    assert.equal(resolveShortRetentionInterval({}, 70), 25);
  });
});

describe("music beat snap", () => {
  it("snaps retention beat to nearest music beat", () => {
    const snap = snapToNearestMusicBeat(2.08, [0, 0.5, 1.0, 1.5, 2.0, 2.5], 0.12);
    assert.equal(snap.snapped, true);
    assert.equal(snap.snappedSec, 2.0);

    const recipe = {
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        timeline: [{ segmentId: "s1", outputStartSec: 0, outputEndSec: 10 }],
      }],
      creativeMoments: [{
        momentId: "beat1",
        outputId: "short_9x16",
        outputStartSec: 2.08,
        outputEndSec: 2.5,
        retentionRole: "beat",
      }],
    };

    enrichRecipeMusicBeatSnap(recipe, {
      musicBeatGrid: { trackId: "shorts_energy_01", bpm: 120, beatsSec: [0, 0.5, 1.0, 1.5, 2.0, 2.5] },
    });
    assert.equal(recipe.creativeMoments[0].outputStartSec, 2.0);
    assert.equal(recipe.musicBeatSnapMeta.momentSnaps, 1);
  });
});

describe("V22-08 intro start validation", () => {
  it("flags greeting intro on short without hook", () => {
    const catalog = loadTechniqueCatalog({ pack: "shorts_retention_2026" });
    const recipe = {
      version: "2.4",
      batchContext: { requiredFormats: ["9:16"] },
      creativityProfile: { level: "shorts" },
      shortsRetentionProfile: { enabled: true },
      outputs: [{
        outputId: "short_9x16",
        outputKind: "short",
        timeline: [{
          segmentId: "s1",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 20,
          audioInSec: 0,
          audioOutSec: 20,
          outputEndSec: 20,
        }],
      }],
      creativeMoments: [],
    };
    const wordIndexes = [{
      clipId: "clip01",
      words: [{ word: "Hej", start: 0, end: 0.3, isFiller: false }],
    }];
    const timelineIndex = {
      scenes: [{ sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 20 }],
      words: wordIndexes[0].words,
    };

    const issues = validateShortsRetention(recipe, catalog, {
      creativityLevel: "shorts",
      wordIndexes,
      timelineIndex,
    });
    assert.ok(issues.some((issue) => issue.code === "V22-08"));
  });
});
