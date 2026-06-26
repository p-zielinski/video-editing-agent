import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { computeCreativityBudget } from "../../src/editorial/technique-budget.js";
import { validateCreativeMoments } from "../../src/validators/creative-moments.js";
import { EditRecipeV2Schema } from "../../src/schemas/edit-recipe-v2.js";

const baseRecipe = {
  version: "2.1",
  batchId: "test01",
  batchContext: { requiredFormats: ["16:9", "9:16"] },
  clipRegistry: [
    { clipId: "clip01", fileName: "a.mov", durationSec: 900, sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true, speechWordCount: 100 },
  ],
  outputs: [
    {
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [
        {
          segmentId: "seg_001",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 900,
          audioInSec: 0,
          audioOutSec: 900,
          outputStartSec: 0,
          outputEndSec: 900,
          audioPolicy: "from_video_ref",
        },
      ],
    },
    {
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      title: "Short",
      timeline: [
        {
          segmentId: "seg_short",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          outputStartSec: 0,
          outputEndSec: 60,
          audioPolicy: "from_video_ref",
        },
      ],
    },
  ],
  creativityProfile: {
    level: "balanced",
    allowMidSentenceCuts: false,
    techniquePack: "youtube_vlog_2026",
  },
};

describe("validateCreativeMoments", () => {
  const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });
  const budget = computeCreativityBudget(900, baseRecipe.creativityProfile);

  it("accepts valid zoom moment with anchorWordId", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_001",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          params: { factor: 1.12, anchor: "face" },
          anchorWordId: "clip01_w0042",
          segmentId: "seg_001",
          reason: "Punchline po setupie",
          confidence: 0.85,
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.equal(issues.filter((i) => i.severity === "error").length, 0);
  });

  it("rejects cut_mid_sentence without allowMidSentenceCuts (V21-03)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_002",
          techniqueId: "cut_mid_sentence",
          outputId: "main_16x9",
          outputStartSec: 100,
          outputEndSec: 100.5,
          reason: "Energiczne cięcie",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-03"));
  });

  it("rejects unknown techniqueId (V21-01)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_003",
          techniqueId: "fake_technique",
          outputId: "main_16x9",
          outputStartSec: 10,
          outputEndSec: 12,
          reason: "Test",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-01"));
  });

  it("rejects params out of range (V21-02)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_004",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 50,
          outputEndSec: 52,
          params: { factor: 2.0 },
          anchorWordId: "clip01_w0050",
          segmentId: "seg_001",
          reason: "Za duży zoom",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-02"));
  });

  it("rejects empty reason (V21-08)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_005",
          techniqueId: "cut_on_beat",
          outputId: "main_16x9",
          outputStartSec: 20,
          outputEndSec: 20.1,
          reason: "   ",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-08"));
  });

  it("rejects zoom on broll segment (V21-06)", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "seg_broll",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 200,
      audioOutSec: 205,
      outputStartSec: 200,
      outputEndSec: 205,
      audioPolicy: "from_audio_ref",
    });
    recipe.creativeMoments = [
      {
        momentId: "cm_006",
        techniqueId: "zoom_punch_in",
        outputId: "main_16x9",
        outputStartSec: 201,
        outputEndSec: 203,
        anchorWordId: "clip01_w0201",
        segmentId: "seg_broll",
        reason: "Zoom na broll",
      },
    ];
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-06"));
  });

  it("rejects match_cut at balanced level (V21-03 level gate)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_match",
          techniqueId: "match_cut",
          outputId: "main_16x9",
          outputStartSec: 100,
          outputEndSec: 100.5,
          reason: "Match cut test",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-03" && i.message.includes("match_cut")));
  });

  it("rejects overlapping same technique with insufficient end→start gap (V21-04)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_a",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 50,
          outputEndSec: 92,
          anchorWordId: "clip01_w0050",
          segmentId: "seg_001",
          reason: "First punch",
        },
        {
          momentId: "cm_b",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 100,
          outputEndSec: 102,
          anchorWordId: "clip01_w0100",
          segmentId: "seg_001",
          reason: "Second punch too soon",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-04"));
  });

  it("counts maxPerOutputMinutes per outputId (V21-05)", () => {
    const shortBudget = computeCreativityBudget(60, baseRecipe.creativityProfile);
    const recipe = structuredClone(baseRecipe);
    recipe.creativeMoments = Array.from({ length: 5 }, (_, i) => ({
      momentId: `cm_${i}`,
      techniqueId: "match_cut",
      outputId: "short_9x16",
      outputStartSec: i * 15,
      outputEndSec: i * 15 + 0.5,
      reason: `Match ${i}`,
    }));
    const boldBudget = { ...shortBudget, level: "bold" };
    const issues = validateCreativeMoments(recipe, catalog, boldBudget);
    assert.ok(issues.some((i) => i.code === "V21-05" && i.message.includes("short_9x16")));
  });

  it("warns when spatial anchor missing (V21-07)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_nospatial",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 50,
          outputEndSec: 52,
          reason: "Bez anchora",
          confidence: 0.9,
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-07"));
    assert.ok(issues.some((i) => i.code === "NEEDS_SPATIAL_REVIEW"));
  });

  it("rejects duplicate momentId (V21-STRUCT)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_dup",
          techniqueId: "cut_on_beat",
          outputId: "main_16x9",
          outputStartSec: 10,
          outputEndSec: 10.1,
          reason: "A",
        },
        {
          momentId: "cm_dup",
          techniqueId: "cut_on_beat",
          outputId: "main_16x9",
          outputStartSec: 20,
          outputEndSec: 20.1,
          reason: "B",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-STRUCT" && i.message.includes("Zduplikowany")));
  });

  it("rejects unknown anchorWordId when word index provided (V21-09)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bad_anchor",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          anchorWordId: "clip01_w9999",
          segmentId: "seg_001",
          reason: "Nieistniejące słowo",
        },
      ],
    };
    const wordIds = new Set(["clip01_w0001", "clip01_w0042"]);
    const issues = validateCreativeMoments(recipe, catalog, budget, { wordIds });
    assert.ok(issues.some((i) => i.code === "V21-09"));
  });

  it("accepts anchorWordId present in word index (V21-09)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_ok_anchor",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          anchorWordId: "clip01_w0042",
          segmentId: "seg_001",
          reason: "Istniejące słowo",
        },
      ],
    };
    const wordIds = new Set(["clip01_w0042"]);
    const issues = validateCreativeMoments(recipe, catalog, budget, { wordIds });
    assert.equal(issues.filter((i) => i.code === "V21-09").length, 0);
  });

  it("rejects malformed anchorWordId without word index (V21-09 format)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_fmt",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          anchorWordId: "invalid-id",
          segmentId: "seg_001",
          reason: "Zły format",
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget);
    assert.ok(issues.some((i) => i.code === "V21-09"));
  });

  it("counts ken_burns_light toward camera zoom budget", () => {
    const smallBudget = computeCreativityBudget(60, { level: "balanced" });
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "seg_broll_kb",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      outputStartSec: 0,
      outputEndSec: 300,
      audioPolicy: "from_audio_ref",
    });
    recipe.creativeMoments = Array.from({ length: smallBudget.maxZoomMoments + 2 }, (_, i) => ({
      momentId: `cm_kb_${i}`,
      techniqueId: "ken_burns_light",
      outputId: "main_16x9",
      outputStartSec: i * 25,
      outputEndSec: i * 25 + 2,
      segmentId: "seg_broll_kb",
      reason: `Ken ${i}`,
    }));
    const issues = validateCreativeMoments(recipe, catalog, smallBudget);
    assert.ok(issues.some((i) => i.code === "V21-05" && i.message.includes("Camera moments")));
  });

  it("accepts spatialRef with bbox and anchorType in schema", () => {
    const recipe = EditRecipeV2Schema.parse({
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_spatial",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.1, 0.2, 0.5, 0.6],
          },
          segmentId: "seg_001",
          reason: "Zoom na twarz",
        },
      ],
    });
    assert.equal(recipe.creativeMoments[0].spatialRef.anchorType, "subject");
  });

  it("rejects spatialRef without timestampSec or bbox+anchorType", () => {
    assert.throws(() => EditRecipeV2Schema.parse({
      version: "2.1",
      batchId: "test01",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      outputs: baseRecipe.outputs,
      creativeMoments: [
        {
          momentId: "cm_bad_spatial",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
          },
          reason: "Brak anchora",
        },
      ],
    }));
  });

  it("errors when spatialRef.sceneId missing from spatial index (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_unknown_scene",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene999",
            anchorType: "subject",
            bbox: [0.1, 0.2, 0.5, 0.6],
          },
          reason: "Nieznana scena",
        },
      ],
    };
    const spatialIndex = {
      scenes: [
        {
          sceneId: "clip01_scene001",
          anchors: [{
            type: "subject",
            bbox: [0.1, 0.2, 0.5, 0.6],
            timestampSec: 5,
            label: "person",
            confidence: 0.8,
          }],
        },
      ],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error"));
  });

  it("errors when spatialRef.bbox provided but scene has no anchors (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_no_anchors",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.1, 0.2, 0.5, 0.6],
          },
          reason: "Bbox bez anchorów",
        },
      ],
    };
    const spatialIndex = { scenes: [{ sceneId: "clip01_scene001", anchors: [] }] };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error"));
  });

  it("warns when spatialRef.bbox diverges at low confidence (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bbox_drift_low",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.8, 0.8, 0.1, 0.1],
          },
          reason: "Odbiegający bbox niski confidence",
          confidence: 0.5,
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        clipId: "clip01",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "warning"));
  });

  it("errors when spatialRef.bbox diverges at high confidence (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bbox_drift",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.8, 0.8, 0.1, 0.1],
          },
          reason: "Odbiegający bbox",
          confidence: 0.85,
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        clipId: "clip01",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error"));
  });

  it("errors when spatialRef.clipId mismatches sceneId prefix (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bad_clip",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip99",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.1, 0.2, 0.5, 0.6],
          },
          reason: "Zły clipId",
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        clipId: "clip01",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error" && i.message.includes("clipId")));
  });

  it("errors when spatialRef.anchorType mismatches at high confidence (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_type_mismatch",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "face",
            bbox: [0.1, 0.2, 0.5, 0.6],
          },
          reason: "Zły anchorType",
          confidence: 0.9,
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        clipId: "clip01",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error" && i.message.includes("anchorType")));
  });

  it("errors when spatialRef.bbox diverges from primary anchor at default confidence (V21-10)", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bbox_drift",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.8, 0.8, 0.1, 0.1],
          },
          reason: "Odbiegający bbox",
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.ok(issues.some((i) => i.code === "V21-10" && i.severity === "error"));
  });

  it("passes V21-10 when spatialRef matches primary anchor", () => {
    const recipe = {
      ...baseRecipe,
      creativeMoments: [
        {
          momentId: "cm_bbox_ok",
          techniqueId: "zoom_punch_in",
          outputId: "main_16x9",
          outputStartSec: 42,
          outputEndSec: 44.5,
          spatialRef: {
            clipId: "clip01",
            sceneId: "clip01_scene001",
            anchorType: "subject",
            bbox: [0.11, 0.21, 0.5, 0.6],
          },
          reason: "Zgodny bbox",
        },
      ],
    };
    const spatialIndex = {
      scenes: [{
        sceneId: "clip01_scene001",
        anchors: [{
          type: "subject",
          bbox: [0.1, 0.2, 0.5, 0.6],
          timestampSec: 5,
          label: "person",
          confidence: 0.8,
        }],
      }],
    };
    const issues = validateCreativeMoments(recipe, catalog, budget, { spatialIndex });
    assert.equal(issues.filter((i) => i.code === "V21-10").length, 0);
  });
});
