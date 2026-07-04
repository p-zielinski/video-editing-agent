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

  it("V22-VLOG-06 errors when two pattern_interrupt fall in same 10min window on 12min main", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs[0].targetDurationSec = 720;
    recipe.outputs[0].timeline[0].outputEndSec = 720;
    recipe.outputs[0].timeline[0].videoOutSec = 720;
    recipe.outputs[0].timeline[0].audioOutSec = 720;
    recipe.creativeMoments = [
      ...validVlogMoments(),
      {
        momentId: "cm_pi_1",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 60,
        outputEndSec: 63,
        reason: "PI 1",
      },
      {
        momentId: "cm_pi_2",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 300,
        outputEndSec: 303,
        reason: "PI 2",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-06" && i.severity === "error"));
  });

  it("V22-VLOG-06 warns when one pattern_interrupt reaches per-10min limit on main", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs[0].targetDurationSec = 600;
    recipe.outputs[0].timeline[0].outputEndSec = 600;
    recipe.outputs[0].timeline[0].videoOutSec = 600;
    recipe.outputs[0].timeline[0].audioOutSec = 600;
    recipe.creativeMoments = [
      ...validVlogMoments(),
      {
        momentId: "cm_pi_1",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 120,
        outputEndSec: 123,
        reason: "PI at limit",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-06" && i.severity === "warning"));
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-06" && i.severity === "error").length, 0);
  });

  it("V22-VLOG-06 ignores pattern_interrupt on short output", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs.push({
      outputId: "short_9x16",
      format: "9:16",
      outputKind: "short",
      targetDurationSec: 45,
      timeline: [{ outputEndSec: 45, videoInSec: 0, videoOutSec: 45 }],
    });
    recipe.creativeMoments = [
      ...validVlogMoments(),
      {
        momentId: "cm_pi_short",
        techniqueId: "pattern_interrupt",
        outputId: "short_9x16",
        outputStartSec: 5,
        outputEndSec: 8,
        reason: "Short PI",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-06").length, 0);
  });

  it("V22-VLOG-06 respects narrativeProfile.maxPatternInterruptsPer10Min override", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs[0].targetDurationSec = 720;
    recipe.outputs[0].timeline[0].outputEndSec = 720;
    recipe.outputs[0].timeline[0].videoOutSec = 720;
    recipe.outputs[0].timeline[0].audioOutSec = 720;
    recipe.narrativeProfile = { maxPatternInterruptsPer10Min: 2 };
    recipe.creativeMoments = [
      ...validVlogMoments(),
      {
        momentId: "cm_pi_1",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 60,
        outputEndSec: 63,
        reason: "PI 1",
      },
      {
        momentId: "cm_pi_2",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 300,
        outputEndSec: 303,
        reason: "PI 2",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-06").length, 0);
  });

  it("V22-VLOG-06 runs when vlogRetentionProfile disabled but main output exists", () => {
    const recipe = structuredClone(baseVlogRecipe);
    recipe.vlogRetentionProfile = { enabled: false };
    recipe.outputs[0].targetDurationSec = 720;
    recipe.outputs[0].timeline[0].outputEndSec = 720;
    recipe.outputs[0].timeline[0].videoOutSec = 720;
    recipe.outputs[0].timeline[0].audioOutSec = 720;
    recipe.creativeMoments = [
      {
        momentId: "cm_pi_1",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 60,
        outputEndSec: 63,
        reason: "PI 1",
      },
      {
        momentId: "cm_pi_2",
        techniqueId: "pattern_interrupt",
        outputId: "main_16x9",
        outputStartSec: 300,
        outputEndSec: 303,
        reason: "PI 2",
      },
    ];
    const issues = validateVlogRetention(recipe, catalog);
    assert.ok(issues.some((i) => i.code === "V22-VLOG-06" && i.severity === "error"));
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-01").length, 0);
    assert.equal(issues.filter((i) => i.code === "V22-VLOG-02").length, 0);
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

  const tenMinNarrativeFixtures = () => {
    const abstraction = {
      L2: [
        {
          segmentId: "seg_fast",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene001"],
        },
        {
          segmentId: "seg_slow",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene002"],
          narrativeRole: "breath",
        },
      ],
    };
    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 300 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 0, endSec: 300 },
      ],
    };
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs[0].targetDurationSec = 600;
    recipe.outputs[0].timeline = [
      {
        segmentId: "m_fast",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 300,
        audioInSec: 0,
        audioOutSec: 300,
        audioPolicy: "from_video_ref",
        outputStartSec: 0,
        outputEndSec: 300,
      },
      {
        segmentId: "m_slow",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
        videoInSec: 0,
        videoOutSec: 300,
        audioInSec: 0,
        audioOutSec: 300,
        audioPolicy: "from_video_ref",
        outputStartSec: 300,
        outputEndSec: 600,
      },
    ];
    recipe.narrativeProfile = {
      segments: [{ l2SegmentId: "seg_slow", rhythm: "slow", retentionIntensity: "low" }],
    };
    return { recipe, abstraction, timelineIndex };
  };

  function beatMomentsAt(times) {
    const techniques = ["zoom_slow_push", "ken_burns_light", "music_swell", "silence_beat"];
    return times.map((outputStartSec, index) => ({
      momentId: `cm_beat_${index}`,
      techniqueId: techniques[index % techniques.length],
      outputId: "main_16x9",
      outputStartSec,
      outputEndSec: outputStartSec + 4,
      retentionRole: "beat",
      reason: `Beat ${index + 1}`,
    }));
  }

  it("V22-VLOG-01 exempts 5min slow L2 when narrativeProfile present — fewer beats required", () => {
    const { recipe, abstraction, timelineIndex } = tenMinNarrativeFixtures();
    recipe.creativeMoments = beatMomentsAt([48, 93, 138, 183, 228, 273]);

    const withProfile = validateVlogRetention(recipe, catalog, { abstraction, timelineIndex });
    assert.equal(withProfile.filter((i) => i.code === "V22-VLOG-01").length, 0);

    delete recipe.narrativeProfile;
    const withoutProfile = validateVlogRetention(recipe, catalog, { abstraction, timelineIndex });
    assert.equal(withoutProfile.filter((i) => i.code === "V22-VLOG-01").length, 0);
  });

  it("V22-VLOG-02 exempts slow breath segment — no beat required mid-breath", () => {
    const abstraction = {
      L2: [
        {
          segmentId: "seg_open",
          startSec: 0,
          endSec: 200,
          sceneIds: ["clip01_scene001"],
        },
        {
          segmentId: "seg_breath",
          startSec: 0,
          endSec: 300,
          sceneIds: ["clip01_scene002"],
          narrativeRole: "breath",
        },
        {
          segmentId: "seg_close",
          startSec: 0,
          endSec: 100,
          sceneIds: ["clip01_scene003"],
        },
      ],
    };
    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 200 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 0, endSec: 300 },
        { sceneId: "clip01_scene003", clipId: "clip01", startSec: 0, endSec: 100 },
      ],
    };
    const recipe = structuredClone(baseVlogRecipe);
    recipe.outputs[0].targetDurationSec = 600;
    recipe.outputs[0].timeline = [
      {
        segmentId: "m_open",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 200,
        audioInSec: 0,
        audioOutSec: 200,
        audioPolicy: "from_video_ref",
        outputStartSec: 0,
        outputEndSec: 200,
      },
      {
        segmentId: "m_breath",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
        videoInSec: 0,
        videoOutSec: 300,
        audioInSec: 0,
        audioOutSec: 300,
        audioPolicy: "from_video_ref",
        outputStartSec: 200,
        outputEndSec: 500,
      },
      {
        segmentId: "m_close",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene003" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene003" },
        videoInSec: 0,
        videoOutSec: 100,
        audioInSec: 0,
        audioOutSec: 100,
        audioPolicy: "from_video_ref",
        outputStartSec: 500,
        outputEndSec: 600,
      },
    ];
    recipe.narrativeProfile = {
      segments: [{ l2SegmentId: "seg_breath", rhythm: "slow", retentionIntensity: "low" }],
    };
    recipe.creativeMoments = beatMomentsAt([48, 93, 138, 188, 505, 550]);

    const withProfile = validateVlogRetention(recipe, catalog, { abstraction, timelineIndex });
    assert.equal(withProfile.filter((i) => i.code === "V22-VLOG-02").length, 0);

    delete recipe.narrativeProfile;
    const withoutProfile = validateVlogRetention(recipe, catalog, { abstraction, timelineIndex });
    assert.equal(withoutProfile.filter((i) => i.code === "V22-VLOG-02").length, 0);
  });
});
