import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCreativeMoments } from "../../src/validators/creative-moments.js";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { computeCreativityBudget } from "../../src/editorial/technique-budget.js";

function baseTimelineRecipe(creativeMoments, extra = {}) {
  return {
    outputs: [{
      outputId: "main_16x9",
      timeline: [{
        segmentId: "seg_001",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 30,
        audioInSec: 0,
        audioOutSec: 30,
        outputStartSec: 0,
        outputEndSec: 30,
      }],
    }],
    creativeMoments,
    ...extra,
  };
}

describe("creative-moments beat sync", () => {
  it("emits V21-11 warning when cut_on_beat is far from nearest beat", () => {
    const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
    const budget = computeCreativityBudget(120, { level: "balanced" });

    const recipe = baseTimelineRecipe([{
      momentId: "cm_beat",
      techniqueId: "cut_on_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 5,
      outputEndSec: 5.1,
      params: { snapToleranceSec: 0.2 },
      reason: "test beat cut",
    }]);

    const audioIndexByClip = new Map([
      ["clip01", { beatTimes: [0.5, 1.0, 6.0] }],
    ]);

    const issues = validateCreativeMoments(recipe, catalog, budget, { audioIndexByClip });
    const beatIssue = issues.find((i) => i.code === "V21-11");
    assert.ok(beatIssue);
    assert.equal(beatIssue.severity, "warning");
  });
});

describe("creative-moments audio technique validators", () => {
  const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
  const budget = computeCreativityBudget(120, { level: "balanced" });
  const boldBudget = computeCreativityBudget(120, { level: "bold" });

  it("emits V21-12 when music_swell has no audioMixPlan.musicBed", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_swell",
      techniqueId: "music_swell",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 10,
      outputEndSec: 13,
      reason: "reveal swell",
    }]);

    const issues = validateCreativeMoments(recipe, catalog, budget);
    const issue = issues.find((i) => i.code === "V21-12");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
  });

  it("skips V21-12 when music_swell has audioMixPlan.musicBed", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_swell",
      techniqueId: "music_swell",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 10,
      outputEndSec: 13,
      reason: "reveal swell",
    }], {
      audioMixPlan: {
        musicBed: { trackId: "upbeat_vlog_01", volumeDb: -20, duckingDb: -14 },
      },
    });

    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.equal(issues.some((i) => i.code === "V21-12"), false);
  });

  it("emits V21-13 when silence_beat is far from silenceGap and cutSuggestion", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_silence",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 5,
      outputEndSec: 5.8,
      params: { durationSec: 0.8 },
      reason: "dramatic pause",
    }]);

    const audioIndexByClip = new Map([
      ["clip01", {
        silenceGaps: [{ startSec: 20, endSec: 21.2, durationSec: 1.2 }],
        cutSuggestions: [{ timeSec: 22, reason: "silence_start", strength: 0.65 }],
      }],
    ]);

    const issues = validateCreativeMoments(recipe, catalog, boldBudget, { audioIndexByClip });
    const issue = issues.find((i) => i.code === "V21-13");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
  });

  it("skips V21-13 when silence_beat aligns with nearby silenceGap", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_silence",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 20,
      outputEndSec: 20.8,
      params: { durationSec: 0.8 },
      reason: "dramatic pause at gap",
    }]);

    const audioIndexByClip = new Map([
      ["clip01", {
        silenceGaps: [{ startSec: 20, endSec: 21.2, durationSec: 1.2 }],
        cutSuggestions: [],
      }],
    ]);

    const issues = validateCreativeMoments(recipe, catalog, boldBudget, { audioIndexByClip });
    assert.equal(issues.some((i) => i.code === "V21-13"), false);
  });

  it("skips V21-13 for hard mute with retentionRole beat without silenceGap", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_hard_mute",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 5,
      outputEndSec: 5.5,
      retentionRole: "beat",
      params: { durationSec: 0.5, volumeFactor: 0 },
      reason: "pattern interrupt before reveal",
    }]);

    const audioIndexByClip = new Map([
      ["clip01", {
        silenceGaps: [{ startSec: 20, endSec: 21.2, durationSec: 1.2 }],
        cutSuggestions: [{ timeSec: 22, reason: "silence_start", strength: 0.65 }],
      }],
    ]);

    const issues = validateCreativeMoments(recipe, catalog, boldBudget, { audioIndexByClip });
    assert.equal(issues.some((i) => i.code === "V21-13"), false);
  });

  it("emits V21-13 for hard mute without retentionRole hook beat payoff", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_hard_mute_bad",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 5,
      outputEndSec: 5.5,
      params: { durationSec: 0.5, volumeFactor: 0 },
      reason: "hard mute without role",
    }]);

    const issues = validateCreativeMoments(recipe, catalog, boldBudget, { audioIndexByClip: new Map() });
    const issue = issues.find((i) => i.code === "V21-13");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
    assert.match(issue.message, /retentionRole/);
  });

  it("skips V21-13 when silence_beat aligns with nearby cutSuggestion", () => {
    const recipe = baseTimelineRecipe([{
      momentId: "cm_silence",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "seg_001",
      outputStartSec: 6,
      outputEndSec: 6.8,
      params: { durationSec: 0.8 },
      reason: "pause on suggested cut",
    }]);

    const audioIndexByClip = new Map([
      ["clip01", {
        silenceGaps: [],
        cutSuggestions: [{ timeSec: 6.2, reason: "silence_start", strength: 0.7 }],
      }],
    ]);

    const issues = validateCreativeMoments(recipe, catalog, boldBudget, { audioIndexByClip });
    assert.equal(issues.some((i) => i.code === "V21-13"), false);
  });
});
