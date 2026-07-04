import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { validateShortsRetention } from "../../src/validators/shorts-retention.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";

const baseShortRecipe = {
  version: "2.2",
  batchId: "short01",
  batchContext: {
    requiredFormats: ["16:9", "9:16"],
  },
  clipRegistry: [],
  outputs: [
    {
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [
        {
          segmentId: "m1",
          segmentRole: "aroll",
          videoRef: { clipId: "c1", sceneId: "c1_s1" },
          audioRef: { clipId: "c1", sceneId: "c1_s1" },
          videoInSec: 0,
          videoOutSec: 60,
          audioInSec: 0,
          audioOutSec: 60,
          audioPolicy: "from_video_ref",
          outputEndSec: 60,
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
          segmentId: "s1",
          segmentRole: "aroll",
          videoRef: { clipId: "c1", sceneId: "c1_s2" },
          audioRef: { clipId: "c1", sceneId: "c1_s2" },
          videoInSec: 0,
          videoOutSec: 45,
          audioInSec: 0,
          audioOutSec: 45,
          audioPolicy: "from_video_ref",
          outputEndSec: 45,
        },
      ],
    },
  ],
  excluded: [],
  sceneUsageRegistry: [],
  creativityProfile: {
    level: "shorts",
    techniquePack: "shorts_retention_2026",
    allowMidSentenceCuts: true,
  },
  shortsRetentionProfile: {
    enabled: true,
    hookWindowSec: 3,
    retentionBeatIntervalSec: 25,
    retentionBeatToleranceSec: 5,
    minRetentionBeats: 2,
    requireHookMoment: true,
    requireHookOverlay: true,
  },
  creativeMoments: [],
};

function validMoments() {
  return [
    {
      momentId: "cm_hook",
      techniqueId: "snap_zoom",
      outputId: "short_9x16",
      outputStartSec: 0.5,
      outputEndSec: 2,
      retentionRole: "hook",
      reason: "Hook wizualny",
    },
    {
      momentId: "cm_hook_text",
      techniqueId: "hook_title_overlay",
      outputId: "short_9x16",
      outputStartSec: 0,
      outputEndSec: 2.5,
      retentionRole: "hook",
      reason: "Hook tekstowy",
    },
    {
      momentId: "cm_beat1",
      techniqueId: "pattern_interrupt",
      outputId: "short_9x16",
      outputStartSec: 24,
      outputEndSec: 26,
      retentionRole: "beat",
      reason: "Beat retencji 1",
    },
    {
      momentId: "cm_beat2",
      techniqueId: "retention_beat",
      outputId: "short_9x16",
      outputStartSec: 40,
      outputEndSec: 42,
      retentionRole: "beat",
      reason: "Beat retencji 2",
    },
  ];
}

describe("shorts-retention validator", () => {
  const catalog = loadTechniqueCatalog({ pack: "shorts_retention_2026" });

  it("V22-01 fails when short lacks hook in 0-3s", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_beat",
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 20,
        outputEndSec: 22,
        retentionRole: "beat",
        reason: "Beat",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    assert.ok(issues.some((i) => i.code === "V22-01" && i.severity === "error"));
  });

  it("V22-02 fails when hook overlay missing", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_hook",
        techniqueId: "snap_zoom",
        outputId: "short_9x16",
        outputStartSec: 1,
        outputEndSec: 2,
        retentionRole: "hook",
        reason: "Hook",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    assert.ok(issues.some((i) => i.code === "V22-02"));
  });

  it("V22-03 counts only retentionRole beat, not techniqueId alone", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      ...validMoments().slice(0, 2),
      {
        momentId: "cm_fake_beat",
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 24,
        outputEndSec: 26,
        retentionRole: "hook",
        reason: "Not a beat",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    assert.ok(issues.some((i) => i.code === "V22-03"));
  });

  it("V22-04 uses beat-only cadence — hook does not mask gap", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_hook",
        techniqueId: "snap_zoom",
        outputId: "short_9x16",
        outputStartSec: 1,
        outputEndSec: 2,
        retentionRole: "hook",
        reason: "Hook",
      },
      {
        momentId: "cm_hook_text",
        techniqueId: "hook_title_overlay",
        outputId: "short_9x16",
        outputStartSec: 0,
        outputEndSec: 2.5,
        retentionRole: "hook",
        reason: "Hook tekst",
      },
      {
        momentId: "cm_beat1",
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 8,
        outputEndSec: 10,
        retentionRole: "beat",
        reason: "Jedyny beat — za wcześnie",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    assert.ok(issues.some((i) => i.code === "V22-04" && i.severity === "error"));
  });

  it("V22-05 fails when hook overlay outside hook window", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = validMoments();
    recipe.outputs[1].timeline[0].textOverlays = [
      {
        text: "ZA PÓŹNO",
        outputStartSec: 5,
        outputEndSec: 7,
        role: "hook",
        style: "hook_large",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-05" && i.severity === "error"));
  });

  it("V22-05 fails for hook_visual_punch outside hook window", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      ...validMoments(),
      {
        momentId: "cm_late_punch",
        techniqueId: "hook_visual_punch",
        outputId: "short_9x16",
        outputStartSec: 5,
        outputEndSec: 7,
        reason: "Za późno",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-05" && i.momentId === "cm_late_punch"));
  });

  it("V22-05 fails for snap_zoom outside hook window", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      ...validMoments(),
      {
        momentId: "cm_late_zoom",
        techniqueId: "snap_zoom",
        outputId: "short_9x16",
        outputStartSec: 4,
        outputEndSec: 5,
        reason: "Snap poza hook",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-05" && i.momentId === "cm_late_zoom"));
  });

  it("V22-07 flags hook overlay exceeding maxHookOverlayDurationSec", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = validMoments();
    recipe.outputs[1].timeline[0].textOverlays = [
      {
        text: "ZA DŁUGO",
        outputStartSec: 0,
        outputEndSec: 6,
        role: "hook",
        style: "hook_large",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-07"));
  });

  it("V22-07 flags overlay budget — max 1 large hook per 15s", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = validMoments();
    recipe.outputs[1].timeline[0].textOverlays = [
      {
        text: "HOOK 1",
        outputStartSec: 10,
        outputEndSec: 12,
        style: "hook_large",
      },
      {
        text: "HOOK 2",
        outputStartSec: 18,
        outputEndSec: 20,
        style: "hook_question",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-07" && i.message.includes("15s")));
  });

  it("main output ignores V22 retention rules", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.outputs = [recipe.outputs[0]];
    recipe.creativeMoments = [];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    assert.equal(issues.length, 0);
  });

  it("v2.1 short recipe without opt-in skips V22", () => {
    const recipe = {
      version: "2.1",
      batchId: "v21",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      clipRegistry: [],
      outputs: baseShortRecipe.outputs,
      excluded: [],
      sceneUsageRegistry: [],
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      creativeMoments: [],
    };
    const issues = validateShortsRetention(recipe, catalog);
    assert.equal(issues.length, 0);
  });

  it("V22-06 rejects graphics on main output", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_bad",
        techniqueId: "hook_title_overlay",
        outputId: "main_16x9",
        outputStartSec: 0,
        outputEndSec: 2,
        reason: "Zły output",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-06" && i.severity === "error"));
  });

  it("V22-06 rejects chapter_card creativeMoment on main output", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_chapter_bad",
        techniqueId: "chapter_card",
        outputId: "main_16x9",
        outputStartSec: 120,
        outputEndSec: 122,
        reason: "Karta na main jako creativeMoment",
      },
    ];
    const issues = validateShortsRetention(recipe, catalog);
    const v2206 = issues.filter((i) => i.code === "V22-06");
    assert.equal(v2206.length, 1);
    assert.equal(v2206[0].momentId, "cm_chapter_bad");
    assert.match(v2206[0].message, /chapter_card/);
  });

  it("main chapter_card textOverlays do not trigger V22-06", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.outputs[0].timeline[0].textOverlays = [
      {
        overlayId: "ch_01",
        text: "Część 2",
        outputStartSec: 120,
        outputEndSec: 123,
        style: "chapter_card",
        role: "retention_beat",
      },
    ];
    recipe.creativeMoments = [];
    const issues = validateShortsRetention(recipe, catalog);
    assert.ok(!issues.some((i) => i.code === "V22-06"));
  });

  it("passes valid short retention recipe", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = validMoments();
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "shorts" });
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 0);
  });

  it("validateRecipeV2 integrates V22 only when retention enabled", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativeMoments = [];
    recipe.shortsRetentionProfile = { enabled: true };
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V22-01"));
  });

  it("validateRecipeV2 skips V22 for v2.1 without opt-in", () => {
    const recipe = {
      version: "2.1",
      batchId: "v21",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      clipRegistry: [],
      outputs: baseShortRecipe.outputs,
      excluded: [],
      sceneUsageRegistry: [],
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      creativeMoments: [],
    };
    const result = validateRecipeV2(recipe);
    assert.equal(result.issues.filter((i) => i.code?.startsWith("V22")).length, 0);
  });

  it("balanced short emits warning severity for V22-01", () => {
    const recipe = structuredClone(baseShortRecipe);
    recipe.creativityProfile.level = "balanced";
    recipe.creativeMoments = [];
    const issues = validateShortsRetention(recipe, catalog, { creativityLevel: "balanced" });
    const v2201 = issues.find((i) => i.code === "V22-01");
    assert.equal(v2201?.severity, "warning");
  });
});
