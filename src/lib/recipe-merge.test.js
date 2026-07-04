import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSegmentRecipes } from "./recipe-merge.js";
import { resolveEffectiveNarrativeProfile } from "./narrative-profile.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";

function buildPartialRecipe(outputId, timeline, creativeMoments = [], segmentId) {
  return {
    segmentId,
    version: "2.4",
    batchId: "batch1",
    batchContext: {
      inputMode: "multi_clip_day",
      requiredFormats: ["16:9"],
      brollStrategy: "match_speech_topics",
    },
    clipRegistry: [],
    outputs: [{
      outputId,
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline,
      chapterMarkers: [],
    }],
    excluded: [],
    creativeMoments,
  };
}

describe("recipe-merge", () => {
  it("stitches timelines by segmentOrder and retimes output positions", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
      crossSegmentNotes: [],
      shortsSources: [],
      excludedClips: [],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [{
      momentId: "cm1",
      techniqueId: "zoom_punch_in",
      outputId: "main_16x9",
      outputStartSec: 2,
      outputEndSec: 4,
      params: {},
      reason: "hook",
      confidence: 0.8,
    }], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);
    const parsed = EditRecipeV2Schema.parse(merged);

    assert.equal(parsed.outputs[0].timeline.length, 2);
    assert.equal(parsed.outputs[0].timeline[0].outputStartSec, 0);
    assert.equal(parsed.outputs[0].timeline[0].outputEndSec, 10);
    assert.equal(parsed.outputs[0].timeline[1].outputStartSec, 10);
    assert.equal(parsed.outputs[0].timeline[1].outputEndSec, 15);
    assert.equal(parsed.creativeMoments[0].outputStartSec, 2);
  });

  it("copies narrativeProfile from super plan onto merged recipe", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      narrativeProfile: {
        mode: "retention_vlog",
        segments: [{
          l2SegmentId: "seg001",
          rhythm: "normal",
          retentionIntensity: "medium",
          silencePolicy: "trim_dead_air",
        }],
        maxPatternInterruptsPer10Min: 2,
        sfxNarrativeOnly: false,
      },
    };
    const partial = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const merged = mergeSegmentRecipes(superPlan, [partial]);
    assert.equal(merged.narrativeProfile.mode, "retention_vlog");
    assert.equal(merged.narrativeProfile.segments[0].l2SegmentId, "seg001");
    assert.equal(merged.narrativeProfile.maxPatternInterruptsPer10Min, 2);
  });

  it("derives narrativeProfile from L2 roles after merge when super plan omits it", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
    };
    const partial = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const merged = mergeSegmentRecipes(superPlan, [partial]);
    assert.equal(merged.narrativeProfile, undefined);

    const abstraction = {
      L2: [{ segmentId: "seg001", narrativeRole: "breath", sceneIds: ["s1"] }],
    };
    const derived = resolveEffectiveNarrativeProfile({ abstraction, recipe: merged });
    assert.equal(derived.segments[0].l2SegmentId, "seg001");
    assert.equal(derived.segments[0].rhythm, "slow");
    assert.equal(derived.segments[0].retentionIntensity, "low");
    assert.equal(derived.segments[0].silencePolicy, "preserve");
  });

  it("unions excluded clips from partials and super plan", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
      excludedClips: ["clip99"],
    };
    const partial = buildPartialRecipe("main_16x9", [], [], "seg001");
    partial.excluded = [{
      exclusionType: "scene",
      sceneId: "s1",
      usableAsBroll: false,
      reason: "weak",
    }];

    const merged = mergeSegmentRecipes(superPlan, [partial]);
    assert.equal(merged.excluded.length, 2);
    assert.ok(merged.excluded.some((entry) => entry.clipId === "clip99"));
  });

  it("matches partials by segmentId when pick order differs from segmentOrder", () => {
    const superPlan = {
      segmentOrder: ["seg002", "seg001"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partialSeg001 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const partialSeg002 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partialSeg001, partialSeg002]);

    assert.equal(merged.outputs[0].timeline[0].videoOutSec, 5);
    assert.equal(merged.outputs[0].timeline[1].videoOutSec, 10);
  });

  it("shortens stitched timeline when cuts remove words", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [{ segmentId: "seg001", priority: 1 }],
    };
    const wordIndexes = {
      clip01: {
        words: [{ wordId: "clip01_w004", word: "do", start: 4.6, end: 4.8 }],
      },
    };
    const partial = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "s1" },
      audioRef: { clipId: "clip01", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 30,
      audioInSec: 0,
      audioOutSec: 30,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [{ startWordId: "clip01_w004", endWordId: "clip01_w004" }],
    }], [], "seg001");

    const merged = mergeSegmentRecipes(superPlan, [partial], { wordIndexes });

    assert.equal(merged.outputs[0].timeline[0].outputStartSec, 0);
    assert.equal(merged.outputs[0].timeline[0].outputEndSec, 29.8);
  });

  it("does not fallback to wrong format output when stitching", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");
    partial1.outputs.push({
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      title: "Short",
      timeline: [{
        segmentId: "p1_short",
        segmentRole: "aroll",
        videoRef: { clipId: "c1", sceneId: "s1" },
        audioRef: { clipId: "c1", sceneId: "s1" },
        videoInSec: 0,
        videoOutSec: 5,
        audioInSec: 0,
        audioOutSec: 5,
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        cuts: [],
      }],
      chapterMarkers: [],
    });

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 8,
      audioInSec: 0,
      audioOutSec: 8,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);
    const shortOutput = merged.outputs.find((output) => output.format === "9:16");

    assert.ok(shortOutput);
    assert.equal(shortOutput.timeline.length, 1);
    assert.equal(shortOutput.timeline[0].videoOutSec, 5);
  });

  it("merges sfxPlan from all partials with stitch time offsets", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");
    partial1.sfxPlan = [{
      sfxId: "whoosh",
      source: "library",
      outputStartSec: 1,
      outputEndSec: 2,
      label: "whoosh",
    }];

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");
    partial2.sfxPlan = [{
      sfxId: "impact",
      source: "library",
      outputStartSec: 2,
      outputEndSec: 3,
      label: "impact",
    }];

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);

    assert.equal(merged.sfxPlan.length, 2);
    assert.equal(merged.sfxPlan[0].outputStartSec, 1);
    assert.equal(merged.sfxPlan[0].outputEndSec, 2);
    assert.equal(merged.sfxPlan[1].outputStartSec, 12);
    assert.equal(merged.sfxPlan[1].outputEndSec, 13);
  });

  it("retimes textOverlays and subtitles when stitching partials", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
      textOverlays: [{
        text: "Hook",
        outputStartSec: 1,
        outputEndSec: 3,
      }],
      subtitles: {
        policy: "phrase",
        sourceClipId: "c1",
        outputStartSec: 0,
        outputEndSec: 10,
      },
    }], [], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
      textOverlays: [{
        text: "Payoff",
        outputStartSec: 0.5,
        outputEndSec: 2,
      }],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);
    const timeline = merged.outputs[0].timeline;

    assert.equal(timeline[0].textOverlays[0].outputStartSec, 1);
    assert.equal(timeline[0].textOverlays[0].outputEndSec, 3);
    assert.equal(timeline[0].subtitles.outputStartSec, 0);
    assert.equal(timeline[0].subtitles.outputEndSec, 10);
    assert.equal(timeline[1].textOverlays[0].outputStartSec, 10.5);
    assert.equal(timeline[1].textOverlays[0].outputEndSec, 12);
  });

  it("filters stitched timeline segments that use super-director excluded clips", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
      excludedClips: ["clip_bad"],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip_bad", sceneId: "s1" },
      audioRef: { clipId: "clip_bad", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);

    assert.equal(merged.outputs[0].timeline.length, 1);
    assert.equal(merged.outputs[0].timeline[0].videoRef.clipId, "c1");
    assert.equal(merged.outputs[0].timeline[0].outputStartSec, 0);
    assert.equal(merged.outputs[0].timeline[0].outputEndSec, 5);
  });

  it("merges sfxPlan using per-output stitch offsets for shorts", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");
    partial1.outputs.push({
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      title: "Short",
      timeline: [{
        segmentId: "p1_short",
        segmentRole: "aroll",
        videoRef: { clipId: "c1", sceneId: "s1" },
        audioRef: { clipId: "c1", sceneId: "s1" },
        videoInSec: 0,
        videoOutSec: 5,
        audioInSec: 0,
        audioOutSec: 5,
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        cuts: [],
      }],
      chapterMarkers: [],
    });
    partial1.sfxPlan = [{
      sfxId: "whoosh",
      source: "library",
      outputId: "short_9x16",
      outputStartSec: 1,
      outputEndSec: 2,
      label: "whoosh",
    }];

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 8,
      audioInSec: 0,
      audioOutSec: 8,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");
    partial2.outputs.push({
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      title: "Short",
      timeline: [{
        segmentId: "p2_short",
        segmentRole: "aroll",
        videoRef: { clipId: "c1", sceneId: "s2" },
        audioRef: { clipId: "c1", sceneId: "s2" },
        videoInSec: 0,
        videoOutSec: 3,
        audioInSec: 0,
        audioOutSec: 3,
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        cuts: [],
      }],
      chapterMarkers: [],
    });
    partial2.sfxPlan = [{
      sfxId: "impact",
      source: "library",
      outputId: "short_9x16",
      outputStartSec: 2,
      outputEndSec: 3,
      label: "impact",
    }];

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);
    const shortSfx = merged.sfxPlan.filter((entry) => entry.outputId === "short_9x16");

    assert.equal(shortSfx.length, 2);
    assert.equal(shortSfx[0].outputStartSec, 1);
    assert.equal(shortSfx[0].outputEndSec, 2);
    assert.equal(shortSfx[1].outputStartSec, 7);
    assert.equal(shortSfx[1].outputEndSec, 8);
  });

  it("includes picked partials missing from segmentOrder", () => {
    const superPlan = {
      segmentOrder: ["seg001"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);

    assert.equal(merged.outputs[0].timeline.length, 2);
    assert.equal(merged.outputs[0].timeline[1].outputStartSec, 10);
  });

  it("unions outputs from partials when first partial lacks a deliverable", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s1" },
      audioRef: { clipId: "c1", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");
    partial2.outputs.push({
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      title: "Short",
      timeline: [{
        segmentId: "p2_short",
        segmentRole: "aroll",
        videoRef: { clipId: "c1", sceneId: "s2" },
        audioRef: { clipId: "c1", sceneId: "s2" },
        videoInSec: 0,
        videoOutSec: 3,
        audioInSec: 0,
        audioOutSec: 3,
        audioPolicy: "from_video_ref",
        overlapSec: 0,
        cuts: [],
      }],
      chapterMarkers: [],
    });

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);
    const shortOutput = merged.outputs.find((output) => output.outputId === "short_9x16");

    assert.ok(shortOutput);
    assert.equal(shortOutput.timeline.length, 1);
    assert.equal(shortOutput.timeline[0].videoOutSec, 3);
  });

  it("computes sfx offsets excluding filtered clips from stitch", () => {
    const superPlan = {
      segmentOrder: ["seg001", "seg002"],
      segmentPicks: [
        { segmentId: "seg001", priority: 1 },
        { segmentId: "seg002", priority: 2 },
      ],
      excludedClips: ["clip_bad"],
    };

    const partial1 = buildPartialRecipe("main_16x9", [{
      segmentId: "p1_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "clip_bad", sceneId: "s1" },
      audioRef: { clipId: "clip_bad", sceneId: "s1" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg001");

    const partial2 = buildPartialRecipe("main_16x9", [{
      segmentId: "p2_s1",
      segmentRole: "aroll",
      videoRef: { clipId: "c1", sceneId: "s2" },
      audioRef: { clipId: "c1", sceneId: "s2" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_video_ref",
      overlapSec: 0,
      cuts: [],
    }], [], "seg002");
    partial2.sfxPlan = [{
      sfxId: "impact",
      source: "library",
      outputStartSec: 1,
      outputEndSec: 2,
      label: "impact",
    }];

    const merged = mergeSegmentRecipes(superPlan, [partial1, partial2]);

    assert.equal(merged.sfxPlan.length, 1);
    assert.equal(merged.sfxPlan[0].outputStartSec, 1);
    assert.equal(merged.sfxPlan[0].outputEndSec, 2);
  });
});
