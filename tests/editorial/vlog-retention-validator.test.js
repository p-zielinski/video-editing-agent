import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTechniqueCatalog } from "../../src/editorial/load-technique-catalog.js";
import { validateRecipeV2 } from "../../src/validators/recipe-v2.js";
import {
  isVlogRetentionBeatMoment,
  shouldRunVlogRetentionValidation,
  validateVlogRetention,
} from "../../src/validators/vlog-retention.js";

const baseVlogRecipe = {
  version: "2.2",
  batchId: "vlog01",
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
      targetDurationSec: 180,
      timeline: [
        {
          segmentId: "m1",
          segmentRole: "aroll",
          videoRef: { clipId: "c1", sceneId: "c1_s1" },
          audioRef: { clipId: "c1", sceneId: "c1_s1" },
          videoInSec: 0,
          videoOutSec: 180,
          audioInSec: 0,
          audioOutSec: 180,
          audioPolicy: "from_video_ref",
          outputEndSec: 180,
        },
      ],
    },
  ],
  excluded: [],
  sceneUsageRegistry: [],
  creativityProfile: {
    level: "balanced",
    techniquePack: "youtube_vlog_2026",
  },
  vlogRetentionProfile: {
    enabled: true,
    hookWindowSec: 3,
    retentionBeatIntervalSec: 45,
    retentionBeatToleranceSec: 8,
    minRetentionBeats: 2,
  },
  creativeMoments: [],
};

function validVlogMoments() {
  return [
    {
      momentId: "cm_beat1",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 48,
      outputEndSec: 52,
      retentionRole: "beat",
      reason: "Beat 1",
    },
    {
      momentId: "cm_beat2",
      techniqueId: "ken_burns_light",
      outputId: "main_16x9",
      outputStartSec: 93,
      outputEndSec: 97,
      retentionRole: "beat",
      reason: "Beat 2",
    },
    {
      momentId: "cm_beat3",
      techniqueId: "music_swell",
      outputId: "main_16x9",
      outputStartSec: 138,
      outputEndSec: 142,
      retentionRole: "beat",
      reason: "Beat 3",
    },
    {
      momentId: "cm_beat4",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      outputStartSec: 170,
      outputEndSec: 174,
      retentionRole: "beat",
      reason: "Beat 4",
    },
  ];
}

describe("vlog-retention validator", () => {
  const catalog = loadTechniqueCatalog({ pack: "youtube_vlog_2026" });

  it("isVlogRetentionBeatMoment requires beat role for vlog rotation techniques", () => {
    assert.equal(
      isVlogRetentionBeatMoment({ techniqueId: "zoom_slow_push", retentionRole: "beat" }),
      true,
    );
    assert.equal(
      isVlogRetentionBeatMoment({ techniqueId: "zoom_slow_push" }),
      false,
    );
    assert.equal(
      isVlogRetentionBeatMoment({ techniqueId: "jump_cut", retentionRole: "beat" }),
      true,
    );
    assert.equal(
      isVlogRetentionBeatMoment({ techniqueId: "jump_cut", retentionRole: "hook" }),
      false,
    );
  });

  it("shouldRunVlogRetentionValidation when vlog profile enabled", () => {
    assert.equal(shouldRunVlogRetentionValidation(baseVlogRecipe), true);
  });

  it("shouldRunVlogRetentionValidation for 16:9 requiredFormats without profile", () => {
    const recipe = structuredClone(baseVlogRecipe);
    delete recipe.vlogRetentionProfile;
    assert.equal(shouldRunVlogRetentionValidation(recipe), true);
  });

  it("shouldRunVlogRetentionValidation skips short-only format", () => {
    const recipe = structuredClone(baseVlogRecipe);
    delete recipe.vlogRetentionProfile;
    recipe.batchContext.requiredFormats = ["9:16"];
    recipe.outputs = [{
      outputId: "short",
      format: "9:16",
      outputKind: "short",
      timeline: [{ outputEndSec: 45, videoInSec: 0, videoOutSec: 45 }],
    }];
    assert.equal(shouldRunVlogRetentionValidation(recipe), false);
  });

  it("shouldRunVlogRetentionValidation skips v2.1 without opt-in", () => {
    const recipe = {
      version: "2.1",
      batchContext: { requiredFormats: ["16:9"] },
      outputs: baseVlogRecipe.outputs,
    };
    assert.equal(shouldRunVlogRetentionValidation(recipe), false);
  });

  it("V22-VLOG-01 fails when main lacks min retention beats", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = validVlogMoments().slice(0, 1);
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-01" && i.severity === "error"));
  });

  it("V22-VLOG-01 counts vlog rotation technique with beat role", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.targetDurationSec = 60;
    recipe.outputs[0].targetDurationSec = 60;
    recipe.outputs[0].timeline[0].outputEndSec = 60;
    recipe.outputs[0].timeline[0].videoOutSec = 60;
    recipe.creativeMoments = [
      {
        momentId: "cm_b1",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 48,
        outputEndSec: 52,
        retentionRole: "beat",
        reason: "Beat",
      },
      {
        momentId: "cm_b2",
        techniqueId: "ken_burns_light",
        outputId: "main_16x9",
        outputStartSec: 55,
        outputEndSec: 58,
        retentionRole: "beat",
        reason: "Beat 2",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-01").length, 0);
  });

  it("V22-VLOG-02 fails when gap between beats exceeds interval + tolerance", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_b1",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 10,
        outputEndSec: 12,
        retentionRole: "beat",
        reason: "Za wcześnie",
      },
      {
        momentId: "cm_b2",
        techniqueId: "ken_burns_light",
        outputId: "main_16x9",
        outputStartSec: 100,
        outputEndSec: 104,
        retentionRole: "beat",
        reason: "Za późno",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-02" && i.severity === "error"));
  });

  it("V22-VLOG-03 warns on aggressive technique on beat", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = [
      ...validVlogMoments().slice(0, 3),
      {
        momentId: "cm_aggressive",
        techniqueId: "jump_cut",
        outputId: "main_16x9",
        outputStartSec: 170,
        outputEndSec: 172,
        retentionRole: "beat",
        reason: "Za agresywny",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-03" && i.momentId === "cm_aggressive"));
  });

  it("V22-VLOG-04 warns on 3+ consecutive beats with same techniqueId", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = [
      {
        momentId: "cm_b1",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 48,
        outputEndSec: 52,
        retentionRole: "beat",
        reason: "Beat 1",
      },
      {
        momentId: "cm_b2",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 93,
        outputEndSec: 97,
        retentionRole: "beat",
        reason: "Beat 2",
      },
      {
        momentId: "cm_b3",
        techniqueId: "zoom_slow_push",
        outputId: "main_16x9",
        outputStartSec: 138,
        outputEndSec: 142,
        retentionRole: "beat",
        reason: "Beat 3",
      },
      {
        momentId: "cm_b4",
        techniqueId: "silence_beat",
        outputId: "main_16x9",
        outputStartSec: 170,
        outputEndSec: 174,
        retentionRole: "beat",
        reason: "Beat 4",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-04"));
  });

  it("V22-VLOG-05 warns when beat far from retentionBeatTargets", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.retentionBeatTargets = [48, 93, 120, 175];
    recipe.creativeMoments = validVlogMoments();
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-05"));
  });

  it("V22-VLOG-05 skipped without explicit retentionBeatTargets", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = validVlogMoments();
    const issues = validateVlogRetention(recipe, catalog);
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-05").length, 0);
  });

  it("passes valid vlog retention recipe", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = validVlogMoments();
    const issues = validateVlogRetention(recipe, catalog);
    const errors = issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 0);
  });

  it("short-only output skips vlog validation", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.batchContext.requiredFormats = ["9:16"];
    recipe.outputs = [{
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      timeline: [{ outputEndSec: 45, videoInSec: 0, videoOutSec: 45 }],
    }];
    recipe.vlogRetentionProfile = { enabled: false };
    const issues = validateVlogRetention(recipe, catalog);
    assert.equal(issues.length, 0);
  });

  it("validateRecipeV2 integrates V22-VLOG when vlog retention enabled", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.creativeMoments = [];
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V22-VLOG-01"));
  });

  it("validateRecipeV2 skips V22-VLOG for v2.1 without opt-in", () => {
    const recipe = {
      version: "2.1",
      batchId: "v21",
      batchContext: { requiredFormats: ["16:9", "9:16"] },
      clipRegistry: [],
      outputs: baseVlogRecipe.outputs,
      excluded: [],
      sceneUsageRegistry: [],
      creativityProfile: { level: "balanced", techniquePack: "youtube_vlog_2026" },
      creativeMoments: [],
    };
    const result = validateRecipeV2(recipe);
    assert.equal(result.issues.filter((i) => i.code?.startsWith("V22-VLOG")).length, 0);
  });
});
