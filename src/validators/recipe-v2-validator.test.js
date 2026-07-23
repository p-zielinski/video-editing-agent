import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRecipeV2, validateBrollTopicIndex, validateAudioMixPlan, validatePacingGuard, validateSfxPlan, validateSfxDensityOnMain, validateRenderStylePresets, validateVoiceoverSegments, hasNarrationSegments, validateDeliveryEngagement } from "./recipe-v2.js";
import { validateVoicePitchMoments } from "./creative-moments.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";
import { resetMusicCatalogCache } from "../editorial/music-library.js";

function createTempMusicCatalog(trackId, fileName = `${trackId}.mp3`) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-val-music-"));
  const trackPath = path.join(tmpDir, fileName);
  fs.writeFileSync(trackPath, "");
  const catalogPath = path.join(tmpDir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    version: "1.0",
    tracks: [{ trackId, fileName, mood: ["upbeat"], bpm: 120 }],
  }));
  return {
    catalogPath,
    trackPath,
    cleanup: () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetMusicCatalogCache();
    },
  };
}

const baseRecipe = {
  version: "2.0",
  batchId: "test01",
  batchContext: {
    inputMode: "multi_clip_day",
    requiredFormats: ["16:9", "9:16"],
    brollMatchThreshold: 0.55,
    maxBrollSegmentsPerOutput: 30,
  },
  clipRegistry: [
    { clipId: "clip01", fileName: "a.mov", durationSec: 100, sortIndex: 0, clipRole: "aroll_primary", hasSpeech: true, speechWordCount: 100 },
    { clipId: "clip02", fileName: "b.mov", durationSec: 50, sortIndex: 1, clipRole: "broll_pool", hasSpeech: false, speechWordCount: 0 },
  ],
  outputs: [
    {
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [
        {
          segmentId: "s1",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
          videoInSec: 0,
          videoOutSec: 30,
          audioInSec: 0,
          audioOutSec: 30,
          audioPolicy: "from_video_ref",
        },
      ],
    },
    {
      outputId: "main_9x16",
      format: "9:16",
      outputKind: "main",
      title: "Vertical",
      timeline: [
        {
          segmentId: "s2",
          segmentRole: "aroll",
          videoRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          audioRef: { clipId: "clip01", sceneId: "clip01_scene002" },
          videoInSec: 0,
          videoOutSec: 20,
          audioInSec: 0,
          audioOutSec: 20,
          audioPolicy: "from_video_ref",
        },
      ],
    },
  ],
  excluded: [],
  sceneUsageRegistry: [],
  vlogRetentionProfile: { enabled: false },
  shortsRetentionProfile: { enabled: false },
};

describe("recipe v2 validator", () => {
  it("accepts valid v2 recipe", () => {
    const result = validateRecipeV2(baseRecipe);
    assert.equal(result.valid, true);
  });

  it("rejects sourceRef in v2 segment", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].sourceRef = { clipId: "clip01", sceneId: "clip01_scene001" };
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "SOURCE_REF_IN_V2_SEGMENT"));
    assert.equal(result.valid, false);
  });

  it("rejects wrong audioPolicy for broll", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0] = {
      segmentId: "b1",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 5,
      audioOutSec: 15,
      audioPolicy: "from_video_ref",
    };
    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{ topicId: "t1", label: "test", wordIds: [], timeRange: { clipId: "clip01", startSec: 0, endSec: 10 }, matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }] }],
      },
    });
    assert.ok(result.issues.some((i) => i.code === "AUDIO_POLICY_VIOLATION"));
  });

  it("rejects whole_clip with usableAsBroll true", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.excluded = [{
      clipId: "clip03",
      exclusionType: "whole_clip",
      usableAsBroll: true,
      reason: "bad",
    }];
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "EXCLUSION_USABLE_BROLL_WHOLE_CLIP"));
  });

  it("rejects scene duplicate in output without allowBrollReuse", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "s1b",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 10,
      audioOutSec: 15,
      audioPolicy: "from_audio_ref",
    });
    recipe.outputs[0].timeline.push({
      segmentId: "s1c",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 5,
      videoOutSec: 10,
      audioInSec: 15,
      audioOutSec: 20,
      audioPolicy: "from_audio_ref",
    });
    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{ topicId: "t1", label: "test", wordIds: [], timeRange: { clipId: "clip01", startSec: 0, endSec: 10 }, matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }] }],
      },
    });
    assert.ok(result.issues.some((i) => i.code === "SCENE_DUPLICATE_IN_OUTPUT"));
  });

  it("warns on deprecated audioOffsetSec", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].audioOffsetSec = 1;
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "DEPRECATED_AUDIO_OFFSET"));
    assert.equal(result.valid, true);
  });

  it("rejects creativeMoments with unknown technique via validateRecipeV2", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.1";
    recipe.creativityProfile = {
      level: "balanced",
      allowMidSentenceCuts: false,
      techniquePack: "youtube_vlog_2026",
    };
    recipe.creativeMoments = [{
      momentId: "cm_bad",
      techniqueId: "nonexistent_technique",
      outputId: "main_16x9",
      outputStartSec: 5,
      outputEndSec: 6,
      reason: "test",
    }];
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V21-01"));
    assert.equal(result.valid, false);
  });

  it("validateBrollTopicIndex passes when scene is in topic index", () => {
    const segment = {
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
    };
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "test",
        matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
      }],
    };
    const issues = validateBrollTopicIndex(segment, topicIndex, baseRecipe.clipRegistry, "main_16x9");
    assert.equal(issues.length, 0);
  });

  it("validateBrollTopicIndex fails when scene not in topic index", () => {
    const clipRegistry = [
      ...baseRecipe.clipRegistry,
      { clipId: "clip03", fileName: "c.mov", durationSec: 30, sortIndex: 2, clipRole: "broll_candidate", hasSpeech: false, speechWordCount: 0 },
    ];
    const segment = {
      segmentRole: "broll",
      videoRef: { clipId: "clip03", sceneId: "clip03_scene999" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
    };
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "test",
        matchingScenes: [{ sceneId: "clip03_scene001", score: 0.8 }],
      }],
    };
    const issues = validateBrollTopicIndex(segment, topicIndex, clipRegistry, "main_16x9");
    assert.ok(issues.some((i) => i.code === "BROLL_SCENE_NOT_IN_TOPIC_INDEX"));
    assert.equal(issues[0].severity, "error");
  });

  it("validateRecipeV2 passes broll scene present in topic index", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "b1",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 10,
      audioOutSec: 15,
      audioPolicy: "from_audio_ref",
    });
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "test",
        wordIds: [],
        timeRange: { clipId: "clip01", startSec: 0, endSec: 30 },
        matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
      }],
    };
    const result = validateRecipeV2(recipe, { topicIndex });
    assert.equal(result.valid, true);
    assert.ok(!result.issues.some((i) => i.code === "BROLL_SCENE_NOT_IN_TOPIC_INDEX"));
  });

  it("validateRecipeV2 rejects broll scene missing from topic index", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry.push({
      clipId: "clip03",
      fileName: "c.mov",
      durationSec: 30,
      sortIndex: 2,
      clipRole: "undecided",
      hasSpeech: false,
      speechWordCount: 0,
    });
    recipe.outputs[0].timeline.push({
      segmentId: "b_bad",
      segmentRole: "broll",
      videoRef: { clipId: "clip03", sceneId: "clip03_scene999" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 10,
      audioOutSec: 15,
      audioPolicy: "from_audio_ref",
    });
    const topicIndex = {
      topics: [{
        topicId: "t1",
        label: "test",
        matchingScenes: [{ sceneId: "clip03_scene001", score: 0.8 }],
      }],
    };
    const result = validateRecipeV2(recipe, { topicIndex });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === "V25-BROLL-03"));
  });

  it("parses v2.3 recipe with audioMixPlan", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.audioMixPlan = {
      voiceTargetLufs: -16,
      musicBed: {
        trackId: "library/intro_bed",
        volumeDb: -20,
        duckingDb: -14,
      },
      preWhisperNormalizeLufs: -18,
      segments: [{
        outputId: "main_16x9",
        musicInSec: 0,
        musicOutSec: 30,
        duckUnderVoice: true,
      }],
    };
    recipe.outputs[0].timeline.push({
      segmentId: "music_bed",
      segmentRole: "aroll",
      videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 0.1,
      audioInSec: 0,
      audioOutSec: 30,
      audioPolicy: "external",
      allowBrollReuse: true,
    });
    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.3");
    assert.equal(parsed.audioMixPlan.musicBed.trackId, "library/intro_bed");
    const { catalogPath, cleanup } = createTempMusicCatalog("library/intro_bed", "intro_bed.mp3");
    try {
      const result = validateRecipeV2(recipe, { musicCatalogPath: catalogPath });
      assert.equal(result.valid, true);
      assert.ok(!result.issues.some((i) => i.code === "V23-01"));
    } finally {
      cleanup();
    }
  });

  it("v2.2 recipe without audioMixPlan remains valid", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.2";
    recipe.creativityProfile = {
      level: "balanced",
      techniquePack: "youtube_vlog_2026",
    };
    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.2");
    assert.equal(parsed.audioMixPlan, undefined);
    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
  });

  it("warns V23-01 when musicBed without external audioPolicy", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.audioMixPlan = {
      voiceTargetLufs: -16,
      musicBed: { trackId: "bed01", volumeDb: -18, duckingDb: -12 },
      preWhisperNormalizeLufs: -18,
      segments: [{ outputId: "main_16x9", duckUnderVoice: true }],
    };
    const { catalogPath, cleanup } = createTempMusicCatalog("bed01");
    try {
      const issues = validateAudioMixPlan(recipe, { catalogPath });
      const issue = issues.find((i) => i.code === "V23-01");
      assert.ok(issue);
      assert.equal(issue.severity, "warning");
    } finally {
      cleanup();
    }
  });

  it("warns V24-05 when main output exceeds source duration with qualityOverQuantity", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.qualityOverQuantity = true;
    recipe.outputs[0].timeline[0].videoOutSec = 160;
    recipe.outputs[0].timeline[0].audioOutSec = 160;

    const issues = validatePacingGuard(recipe);
    assert.ok(issues.some((i) => i.code === "V24-05"));
    assert.equal(issues[0].severity, "warning");

    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
    assert.ok(result.issues.some((i) => i.code === "V24-05"));
  });

  it("warns V24-05 when main output exceeds L3 estimatedKeepRatio budget", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.qualityOverQuantity = false;
    recipe.outputs[0].timeline[0].videoOutSec = 60;
    recipe.outputs[0].timeline[0].audioOutSec = 60;

    const issues = validatePacingGuard(recipe, { estimatedKeepRatio: 0.35 });
    assert.ok(issues.some((i) => i.code === "V24-05"));
    assert.match(issues[0].message, /estimatedKeepRatio/);
  });

  it("warns V21-12 via validateRecipeV2 when music_swell lacks musicBed", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.creativityProfile = { level: "balanced", techniquePack: "youtube_vlog_2026" };
    recipe.creativeMoments = [{
      momentId: "cm_swell",
      techniqueId: "music_swell",
      outputId: "main_16x9",
      segmentId: "s1",
      outputStartSec: 5,
      outputEndSec: 8,
      reason: "section reveal swell",
    }];

    const result = validateRecipeV2(recipe);
    const issue = result.issues.find((i) => i.code === "V21-12");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
    assert.equal(result.valid, true);
  });

  it("warns V21-13 via validateRecipeV2 when silence_beat is off audio anchors", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.creativityProfile = { level: "bold", techniquePack: "youtube_vlog_2026" };
    recipe.creativeMoments = [{
      momentId: "cm_silence",
      techniqueId: "silence_beat",
      outputId: "main_16x9",
      segmentId: "s1",
      outputStartSec: 5,
      outputEndSec: 5.8,
      params: { durationSec: 0.8 },
      reason: "dramatic pause",
    }];

    const audioIndex = {
      clips: [{
        clipId: "clip01",
        silenceGaps: [{ startSec: 20, endSec: 21.2, durationSec: 1.2 }],
        cutSuggestions: [{ timeSec: 22, reason: "silence_start", strength: 0.65 }],
      }],
    };

    const result = validateRecipeV2(recipe, { audioIndex });
    const issue = result.issues.find((i) => i.code === "V21-13");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
    assert.equal(result.valid, true);
  });

  it("warns V26-VOICE-01/02 for voice_pitch_shift out of range or overused", () => {
    const recipe = {
      outputs: [{ outputId: "main_16x9" }],
      creativeMoments: [
        {
          momentId: "cm_pitch_1",
          techniqueId: "voice_pitch_shift",
          outputId: "main_16x9",
          outputStartSec: 1,
          outputEndSec: 2,
          params: { semitones: 12 },
        },
        {
          momentId: "cm_pitch_2",
          techniqueId: "voice_pitch_shift",
          outputId: "main_16x9",
          outputStartSec: 3,
          outputEndSec: 4,
          params: { semitones: 4 },
        },
        {
          momentId: "cm_pitch_3",
          techniqueId: "voice_pitch_shift",
          outputId: "main_16x9",
          outputStartSec: 5,
          outputEndSec: 6,
          params: { semitones: -4 },
        },
      ],
    };

    const issues = validateVoicePitchMoments(recipe);
    assert.ok(issues.some((i) => i.code === "V26-VOICE-01"));
    assert.ok(issues.some((i) => i.code === "V26-VOICE-02"));
  });

  it("errors V27-DELIVERY-03 for voice_resynthesis without consent flags", () => {
    const issues = validateDeliveryEngagement({
      engagementRepairMoments: [{
        momentId: "repair_01",
        clipId: "clip01",
        action: "voice_resynthesis",
        startSec: 1,
        endSec: 5,
        reason: "test",
        consentRequired: false,
        needsHumanReview: false,
      }],
    });
    assert.ok(issues.some((i) => i.code === "V27-DELIVERY-03"));
  });

  it("parses v2.4 recipe with sfxPlan, colorGrade, and renderStylePresets", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "evt_clip01_8500",
      source: "audio_event",
      clipId: "clip01",
      anchorTimeSec: 8.5,
      outputStartSec: 8.5,
      outputEndSec: 9.1,
      label: "laughter",
      reason: "Detected Laughter (score 0.74)",
    }, {
      sfxId: "library/sfx/whoosh",
      source: "library",
      outputStartSec: 0,
      outputEndSec: 0.5,
      label: "whoosh",
    }];
    recipe.colorGrade = {
      lutId: "vlog_warm",
      exposure: 0.1,
      contrast: 1.05,
      saturation: 1.1,
    };
    recipe.renderStylePresets = {
      subtitles: {
        presetId: "default_bold",
        fontFamily: "Inter",
        fontSizePx: 42,
        color: "#FFFFFF",
        strokeColor: "#000000",
        safeMarginPct: 8,
      },
      overlays: {
        hook_large: {
          position: "top_center",
          fontSizePx: 72,
          color: "#FFE566",
        },
      },
      formats: {
        "16:9": { width: 1920, height: 1080 },
        "9:16": {
          width: 1080,
          height: 1920,
          safeZone: { top: 120, bottom: 180, left: 48, right: 48 },
        },
      },
    };

    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.version, "2.4");
    assert.equal(parsed.sfxPlan.length, 2);
    assert.equal(parsed.sfxPlan[0].volumeDb, -6);
    assert.equal(parsed.colorGrade.lutId, "vlog_warm");
    assert.equal(parsed.renderStylePresets.subtitles.presetId, "default_bold");
    assert.equal(parsed.renderStylePresets.overlays.hook_large.fontSizePx, 72);

    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
  });

  it("rejects invalid sfxPlan source enum", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "bad",
      source: "generated",
      outputStartSec: 0,
      outputEndSec: 1,
      label: "test",
    }];

    assert.throws(() => EditRecipeV2Schema.parse(recipe));
  });

  it("parses videoTransform.speed, speedMode, and sourceVolumeDb on timeline segment", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoTransform = {
      speed: 1.5,
      speedMode: "video_audio",
      reframe: "center",
    };
    recipe.outputs[0].timeline[0].sourceVolumeDb = -12;

    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.outputs[0].timeline[0].videoTransform.speed, 1.5);
    assert.equal(parsed.outputs[0].timeline[0].videoTransform.speedMode, "video_audio");
    assert.equal(parsed.outputs[0].timeline[0].sourceVolumeDb, -12);
  });

  it("parses videoTransform.playbackMode and boomerangHalfSec", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoTransform = {
      playbackMode: "boomerang",
      boomerangHalfSec: 1.5,
    };
    recipe.outputs[0].timeline[0].audioPolicy = "mute";

    const parsed = EditRecipeV2Schema.parse(recipe);
    assert.equal(parsed.outputs[0].timeline[0].videoTransform.playbackMode, "boomerang");
    assert.equal(parsed.outputs[0].timeline[0].videoTransform.boomerangHalfSec, 1.5);
  });

  it("warns when reverse/boomerang lacks mute or external audioPolicy", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoTransform = { playbackMode: "reverse" };

    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "PLAYBACK_AUDIO_POLICY"));
  });

  it("warns when boomerangHalfSec is set without boomerang mode", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoTransform = { boomerangHalfSec: 2 };

    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "PLAYBACK_BOOMERANG_HALF_UNUSED"));
  });

  it("warns V23-02 when LUFS targets are outside recommended range", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.audioMixPlan = {
      voiceTargetLufs: -30,
      preWhisperNormalizeLufs: -10,
      musicBed: null,
      segments: [],
    };

    const issues = validateAudioMixPlan(recipe);
    assert.equal(issues.filter((i) => i.code === "V23-02").length, 2);
    assert.ok(issues.every((i) => i.severity === "warning"));
  });

  it("errors V23-03 when musicBed.trackId is not in catalog", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.audioMixPlan = {
      voiceTargetLufs: -16,
      preWhisperNormalizeLufs: -18,
      musicBed: { trackId: "missing_track_xyz", volumeDb: -18, duckingDb: -12 },
      segments: [],
    };

    const issues = validateAudioMixPlan(recipe);
    const issue = issues.find((i) => i.code === "V23-03");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.match(issue.message, /nie występuje w katalogu/);
  });

  it("errors V23-03 when musicBed track file is missing on disk", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.audioMixPlan = {
      voiceTargetLufs: -16,
      preWhisperNormalizeLufs: -18,
      musicBed: { trackId: "calm_reflective_01", volumeDb: -18, duckingDb: -12 },
      segments: [],
    };

    const catalog = createTempMusicCatalog("calm_reflective_01");
    fs.unlinkSync(catalog.trackPath);
    try {
      const issues = validateAudioMixPlan(recipe, { catalogPath: catalog.catalogPath });
      const issue = issues.find((i) => i.code === "V23-03");
      assert.ok(issue);
      assert.equal(issue.severity, "error");
      assert.match(issue.message, /nie istnieje na dysku/);
    } finally {
      catalog.cleanup();
    }
  });

  it("errors V24-01 when sfxPlan audio_event lacks valid clipId", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "sfx_laugh",
      source: "audio_event",
      outputStartSec: 5,
      outputEndSec: 6,
      volumeDb: -6,
      label: "Laugh",
    }];

    const issues = validateSfxPlan(recipe);
    assert.ok(issues.some((i) => i.code === "V24-01" && i.severity === "error"));
  });

  it("errors V24-02 when sfxPlan output range is invalid", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "sfx_whoosh",
      source: "library",
      outputStartSec: 8,
      outputEndSec: 8,
      volumeDb: -6,
      label: "Whoosh",
    }];

    const issues = validateSfxPlan(recipe);
    assert.ok(issues.some((i) => i.code === "V24-02" && i.severity === "error"));
  });

  it("errors V24-03 when sfxPlan anchorTimeSec exceeds clip duration", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "sfx_hit",
      source: "audio_event",
      clipId: "clip01",
      anchorTimeSec: 150,
      outputStartSec: 5,
      outputEndSec: 6,
      volumeDb: -6,
      label: "Hit",
    }];

    const issues = validateSfxPlan(recipe);
    assert.ok(issues.some((i) => i.code === "V24-03" && i.severity === "error"));
  });

  it("warns V24-04 when 9:16 output lacks safeZone in renderStylePresets", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.renderStylePresets = {
      formats: {
        "9:16": { width: 1080, height: 1920 },
      },
    };

    const issues = validateRenderStylePresets(recipe);
    assert.ok(issues.some((i) => i.code === "V24-04" && i.severity === "warning"));
  });

  it("validateRecipeV2 runs sfx validators when sfxPlan present on v2.3 recipe", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.3";
    recipe.sfxPlan = [{
      sfxId: "sfx_bad",
      source: "audio_event",
      outputStartSec: 2,
      outputEndSec: 1,
      volumeDb: -6,
      label: "Bad range",
    }];

    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.code === "V24-02"));
    assert.ok(!result.issues.some((i) => i.code === "V24-04"));
  });

  it("warns V24-06 when sfxPlan exceeds 1 entry per 90s on main", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.outputs[0].timeline[0].videoOutSec = 180;
    recipe.outputs[0].timeline[0].audioOutSec = 180;
    recipe.sfxPlan = [
      { sfxId: "sfx_a", source: "library", outputStartSec: 10, outputEndSec: 10.5, label: "whoosh" },
      { sfxId: "sfx_b", source: "library", outputStartSec: 50, outputEndSec: 50.5, label: "click" },
      { sfxId: "sfx_c", source: "library", outputStartSec: 100, outputEndSec: 100.5, label: "swoosh" },
    ];

    const issues = validateSfxDensityOnMain(recipe);
    assert.ok(issues.some((i) => i.code === "V24-06" && i.severity === "warning"));
    assert.match(issues[0].message, /max 2/);

    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
    assert.ok(result.issues.some((i) => i.code === "V24-06"));
  });

  it("passes V24-06 when sfxPlan within 1 per 90s on main", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.outputs[0].timeline[0].videoOutSec = 180;
    recipe.outputs[0].timeline[0].audioOutSec = 180;
    recipe.sfxPlan = [
      { sfxId: "sfx_a", source: "library", outputStartSec: 10, outputEndSec: 10.5, label: "whoosh" },
      { sfxId: "sfx_b", source: "library", outputStartSec: 100, outputEndSec: 100.5, label: "click" },
    ];

    const issues = validateSfxDensityOnMain(recipe);
    assert.equal(issues.length, 0);
  });

  it("warns V24-06 using narrativeProfile L2 maxSfxEntries sum", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.narrativeProfile = {
      segments: [
        { l2SegmentId: "seg001", rhythm: "normal" },
        { l2SegmentId: "seg002", rhythm: "fast" },
      ],
    };
    recipe.outputs[0].timeline[0].videoOutSec = 300;
    recipe.outputs[0].timeline[0].audioOutSec = 300;
    recipe.sfxPlan = [
      { sfxId: "sfx_a", source: "library", outputStartSec: 10, outputEndSec: 10.5, label: "whoosh" },
      { sfxId: "sfx_b", source: "library", outputStartSec: 50, outputEndSec: 50.5, label: "click" },
      { sfxId: "sfx_c", source: "library", outputStartSec: 100, outputEndSec: 100.5, label: "swoosh" },
      { sfxId: "sfx_d", source: "library", outputStartSec: 150, outputEndSec: 150.5, label: "rise" },
      { sfxId: "sfx_e", source: "library", outputStartSec: 200, outputEndSec: 200.5, label: "hit" },
      { sfxId: "sfx_f", source: "library", outputStartSec: 250, outputEndSec: 250.5, label: "pop" },
    ];

    const abstraction = {
      L2: [
        { segmentId: "seg001", startSec: 0, endSec: 150 },
        { segmentId: "seg002", startSec: 150, endSec: 300 },
      ],
    };

    const issues = validateSfxDensityOnMain(recipe, { abstraction });
    assert.ok(issues.some((i) => i.code === "V24-06" && i.severity === "warning"));
    assert.match(issues[0].message, /max 5/);
    assert.match(issues[0].message, /narrativeProfile L2 caps/);
  });

  it("errors V25-VO-01 when from_audio_ref points to clip without speech", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry.push({
      clipId: "clip03",
      fileName: "03_narration.wav",
      durationSec: 20,
      sortIndex: 2,
      clipRole: "narration_track",
      hasSpeech: false,
      speechWordCount: 0,
      mediaType: "audio_only",
    });
    recipe.outputs[0].timeline.push({
      segmentId: "vo_bad",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
    });

    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "test",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
        }],
      },
    });
    const issue = result.issues.find((i) => i.code === "V25-VO-01");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(result.valid, false);
  });

  it("passes V25-VO-01 when from_audio_ref points to clip with speech", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry.push({
      clipId: "clip03",
      fileName: "03_narration.wav",
      durationSec: 20,
      sortIndex: 2,
      clipRole: "narration_track",
      hasSpeech: true,
      speechWordCount: 50,
      mediaType: "audio_only",
    });
    recipe.outputs[0].timeline.push({
      segmentId: "vo_ok",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
      subtitles: { policy: "word_by_word", sourceClipId: "clip03" },
    });

    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "test",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
        }],
      },
    });
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-01"));
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-02"));
  });

  it("passes V25-VO with mixed aroll and from_audio_ref segments", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry.push({
      clipId: "clip03",
      fileName: "03_narration.wav",
      durationSec: 20,
      sortIndex: 2,
      clipRole: "narration_track",
      hasSpeech: true,
      speechWordCount: 50,
      mediaType: "audio_only",
    });
    recipe.outputs[0].timeline.push({
      segmentId: "vo_mixed",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
      subtitles: { policy: "word_by_word", sourceClipId: "clip03" },
    });

    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "test",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
        }],
      },
    });
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-01"));
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-02"));
  });

  it("errors V25-VO-02 when subtitles sourceClipId lacks speech transcript", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry.push({
      clipId: "clip03",
      fileName: "03_narration.wav",
      durationSec: 20,
      sortIndex: 2,
      clipRole: "narration_track",
      hasSpeech: true,
      speechWordCount: 50,
      mediaType: "audio_only",
    });
    recipe.outputs[0].timeline.push({
      segmentId: "vo_sub_bad",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      videoInSec: 0,
      videoOutSec: 10,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
      subtitles: { policy: "word_by_word", sourceClipId: "clip02" },
    });

    const result = validateRecipeV2(recipe, {
      topicIndex: {
        topics: [{
          topicId: "t1",
          label: "test",
          matchingScenes: [{ sceneId: "clip02_scene001", score: 0.8 }],
        }],
      },
    });
    const issue = result.issues.find((i) => i.code === "V25-VO-02");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(result.valid, false);
  });

  it("skips V25-VO validators when recipe has no narration segments", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].subtitles = {
      policy: "word_by_word",
      sourceClipId: "clip02",
    };

    assert.equal(hasNarrationSegments(recipe), false);
    const issues = validateVoiceoverSegments(
      recipe.outputs[0].timeline[0],
      new Map(recipe.clipRegistry.map((c) => [c.clipId, c])),
      "main_16x9",
    );
    assert.ok(issues.some((i) => i.code === "V25-VO-02"));

    const result = validateRecipeV2(recipe);
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-01"));
    assert.ok(!result.issues.some((i) => i.code === "V25-VO-02"));
  });

  it("skips V25-VO-02 when subtitles policy is off", () => {
    const segment = {
      segmentId: "vo_sub_off",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip03", sceneId: "clip03_scene001" },
      audioPolicy: "from_audio_ref",
      subtitles: { policy: "off", sourceClipId: "clip02" },
    };
    const clipRegistryMap = new Map([
      ["clip02", { clipId: "clip02", hasSpeech: false, speechWordCount: 0 }],
      ["clip03", { clipId: "clip03", hasSpeech: true, speechWordCount: 10 }],
    ]);

    const issues = validateVoiceoverSegments(segment, clipRegistryMap, "main_16x9");
    assert.ok(!issues.some((i) => i.code === "V25-VO-02"));
  });
});

describe("recipe v2 montage quality validators", () => {
  it("validateRecipeV2 emits V25-BROLL-01 for desynced broll", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "broll1",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 3,
      audioInSec: 0,
      audioOutSec: 10,
      audioPolicy: "from_audio_ref",
    });

    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V25-BROLL-01"));
  });

  it("validateRecipeV2 emits V25-BROLL-06 when brollSyncHints diverge", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline.push({
      segmentId: "broll1",
      segmentRole: "broll",
      videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
      audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
      videoInSec: 0,
      videoOutSec: 5,
      audioInSec: 0,
      audioOutSec: 5,
      audioPolicy: "from_audio_ref",
    });

    const result = validateRecipeV2(recipe, {
      brollSyncHints: [{
        sceneId: "clip02_scene001",
        suggestedVideoInSec: 12,
        confidence: 0.9,
      }],
    });
    assert.ok(result.issues.some((i) => i.code === "V25-BROLL-06"));
  });

  it("validateRecipeV2 fails with V25-CHR-01 for inverted sortIndex on main", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline = [
      {
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip02", sceneId: "clip02_scene001" },
        audioRef: { clipId: "clip02", sceneId: "clip02_scene001" },
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
        audioPolicy: "from_video_ref",
      },
      {
        segmentId: "s2",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 10,
        audioInSec: 0,
        audioOutSec: 10,
        audioPolicy: "from_video_ref",
      },
    ];

    const result = validateRecipeV2(recipe);
    const chr01 = result.issues.find((issue) => issue.code === "V25-CHR-01");
    assert.ok(chr01);
    assert.equal(chr01.severity, "error");
    assert.equal(result.valid, false);
  });

  it("validateRecipeV2 errors V25-CHR-03 for cold open without rewind intro", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline = [
      {
        segmentId: "enrich_cold_open_01",
        segmentRole: "aroll",
        videoRef: { clipId: "clip02", sceneId: "clip02_scene002" },
        audioRef: { clipId: "clip02", sceneId: "clip02_scene002" },
        videoInSec: 0,
        videoOutSec: 8,
        audioInSec: 0,
        audioOutSec: 8,
        audioPolicy: "from_video_ref",
      },
      {
        segmentId: "s2",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 20,
        audioInSec: 0,
        audioOutSec: 20,
        audioPolicy: "from_video_ref",
      },
    ];

    const result = validateRecipeV2(recipe);
    const chr03 = result.issues.find((issue) => issue.code === "V25-CHR-03");
    assert.ok(chr03);
    assert.equal(chr03.severity, "error");
    assert.equal(result.valid, false);
  });

  it("validateRecipeV2 errors V25-SPEECH-COVERAGE when dominant speech aroll is omitted", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry = [
      {
        clipId: "clip01",
        fileName: "a.mov",
        durationSec: 60,
        sortIndex: 0,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 40,
      },
      {
        clipId: "clip16",
        fileName: "long-talk.mov",
        durationSec: 300,
        sortIndex: 15,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 200,
      },
      {
        clipId: "clip02",
        fileName: "b.mov",
        durationSec: 50,
        sortIndex: 1,
        clipRole: "broll_pool",
        hasSpeech: false,
        speechWordCount: 0,
      },
    ];
    recipe.outputs[0].timeline = [
      {
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 30,
        audioInSec: 0,
        audioOutSec: 30,
        audioPolicy: "from_video_ref",
      },
    ];

    const result = validateRecipeV2(recipe);
    const issue = result.issues.find((i) => i.code === "V25-SPEECH-COVERAGE");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(issue.clipId, "clip16");
    assert.equal(result.valid, false);
  });

  it("validateRecipeV2 passes V25-SPEECH-COVERAGE when top speech clip is on main", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.clipRegistry = [
      {
        clipId: "clip01",
        fileName: "a.mov",
        durationSec: 60,
        sortIndex: 0,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 40,
      },
      {
        clipId: "clip16",
        fileName: "long-talk.mov",
        durationSec: 300,
        sortIndex: 15,
        clipRole: "aroll_primary",
        hasSpeech: true,
        speechWordCount: 200,
      },
    ];
    recipe.outputs[0].timeline = [
      {
        segmentId: "s1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 20,
        audioInSec: 0,
        audioOutSec: 20,
        audioPolicy: "from_video_ref",
      },
      {
        segmentId: "s2",
        segmentRole: "aroll",
        videoRef: { clipId: "clip16", sceneId: "clip16_scene001" },
        audioRef: { clipId: "clip16", sceneId: "clip16_scene001" },
        videoInSec: 0,
        videoOutSec: 40,
        audioInSec: 0,
        audioOutSec: 40,
        audioPolicy: "from_video_ref",
      },
    ];

    const result = validateRecipeV2(recipe);
    assert.ok(!result.issues.some((i) => i.code === "V25-SPEECH-COVERAGE"));
  });

  it("validateRecipeV2 emits V25-AR-02 with sceneAspectById", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.outputs[0].timeline[0].videoRef = { clipId: "clip01", sceneId: "clip01_scene001" };
    recipe.outputs[0].timeline[0].audioRef = { clipId: "clip01", sceneId: "clip01_scene001" };

    const sceneAspectById = new Map([["clip01_scene001", "9:16"]]);
    const result = validateRecipeV2(recipe, { sceneAspectById });
    assert.ok(result.issues.some((i) => i.code === "V25-AR-02"));
  });

  it("validateRecipeV2 warns V24-07 for unresolvable library sfx", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.sfxPlan = [{
      sfxId: "sfx_unknown_xyz",
      source: "library",
      label: "nonexistent_tag",
      outputStartSec: 1,
      outputEndSec: 1.5,
      volumeDb: -6,
    }];

    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V24-07" && i.severity === "warning"));
  });

  it("validateRecipeV2 warns V26-CHAPTER-01 when chapterCardHints lack overlay coverage", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
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
        videoOutSec: 300,
        audioInSec: 0,
        audioOutSec: 300,
        audioPolicy: "from_video_ref",
        textOverlays: [],
      }],
    }];

    const result = validateRecipeV2(recipe, {
      chapterCardHints: [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }],
    });

    const issue = result.issues.find((entry) => entry.code === "V26-CHAPTER-01");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
    assert.equal(result.valid, true);
  });

  it("validateRecipeV2 passes V26-CHAPTER-01 when chapter_card overlay covers hint", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
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
        videoOutSec: 300,
        audioInSec: 0,
        audioOutSec: 300,
        audioPolicy: "from_video_ref",
        textOverlays: [{
          overlayId: "dir_chapter_1",
          text: "Part 2",
          outputStartSec: 118,
          outputEndSec: 122,
          style: "chapter_card",
        }],
      }],
    }];

    const result = validateRecipeV2(recipe, {
      chapterCardHints: [{ outputId: "main_16x9", targetSec: 120, style: "chapter_card" }],
    });

    assert.equal(result.issues.filter((entry) => entry.code === "V26-CHAPTER-01").length, 0);
  });

  it("validateRecipeV2 returns NAR-BEAT-SPAM for slow segment with enrich beats", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
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
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
      }],
    }];
    recipe.narrativeProfile = {
      segments: [{ l2SegmentId: "seg002", rhythm: "slow" }],
    };
    recipe.creativeMoments = [{
      momentId: "enrich_beat_01",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 150,
      outputEndSec: 151,
      retentionRole: "beat",
      reason: "enrich",
      confidence: 0.7,
    }];

    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene001"], startSec: 120, endSec: 240 },
      ],
    };
    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 240 },
      ],
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex });
    const beatSpam = result.issues.filter((issue) => issue.code === "NAR-BEAT-SPAM");
    assert.equal(beatSpam.length, 1);
    assert.match(beatSpam[0].message, /enrich_beat_/);
  });

  it("validateRecipeV2 returns NAR-PAYOFF-UNDELIVERED when openLoops has payoffSceneId but no payoff", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
      }],
    }];
    recipe.creativeMoments = [];

    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
      ],
    };
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
      ],
      L3: {
        openLoops: [{
          loopId: "loop_01",
          kind: "cold_open",
          setupSceneId: "clip01_scene001",
          payoffSceneId: "clip01_scene002",
          teaseText: "Payoff tease",
        }],
      },
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex });
    assert.ok(result.issues.some((i) => i.code === "NAR-PAYOFF-UNDELIVERED"));
  });

  it("validateRecipeV2 returns NAR-DRAMATIC-PAUSE-CUT when dead_air cut in preserve segment", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.narrativeProfile = {
      silencePolicy: "trim_dead_air",
      segments: [{ l2SegmentId: "seg001", silencePolicy: "preserve" }],
    };
    recipe.outputs = [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 30,
        audioInSec: 0,
        audioOutSec: 30,
        audioPolicy: "from_video_ref",
        cuts: [{
          startWordId: "clip01_w001",
          endWordId: "clip01_w002",
          reason: "dead_air",
        }],
      }],
    }];

    const wordIndexes = [{
      clipId: "clip01",
      words: [
        { wordId: "clip01_w001", word: "hello", start: 0, end: 2 },
        { wordId: "clip01_w002", word: "world", start: 6, end: 8 },
      ],
    }];
    const timelineIndex = {
      scenes: [{ sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 }],
    };
    const abstraction = {
      L2: [{ segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 }],
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex, wordIndexes });
    assert.ok(result.issues.some((i) => i.code === "NAR-DRAMATIC-PAUSE-CUT"));
  });

  it("validateRecipeV2 returns NAR-BREATH-BEAT for beat in breath L2 segment", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
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
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
      }],
    }];
    recipe.creativeMoments = [{
      momentId: "beat_breath",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 150,
      outputEndSec: 151,
      retentionRole: "beat",
      reason: "beat w oddechu",
      confidence: 0.7,
    }];

    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        {
          segmentId: "seg002",
          sceneIds: ["clip01_scene001"],
          startSec: 120,
          endSec: 240,
          narrativeRole: "breath",
        },
      ],
    };
    const timelineIndex = {
      scenes: [{ sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 240 }],
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex });
    assert.ok(result.issues.some((i) => i.code === "NAR-BREATH-BEAT"));
  });

  it("validateRecipeV2 returns NAR-CLOSURE-SPAM for enrich beats in resolution segment", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
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
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
      }],
    }];
    recipe.creativeMoments = [{
      momentId: "enrich_beat_closure",
      techniqueId: "zoom_slow_push",
      outputId: "main_16x9",
      outputStartSec: 150,
      outputEndSec: 151,
      retentionRole: "beat",
      reason: "enrich",
      confidence: 0.7,
    }];

    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        {
          segmentId: "seg002",
          sceneIds: ["clip01_scene001"],
          startSec: 120,
          endSec: 240,
          narrativeRole: "resolution",
        },
      ],
    };
    const timelineIndex = {
      scenes: [{ sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 240 }],
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex });
    assert.ok(result.issues.some((i) => i.code === "NAR-CLOSURE-SPAM"));
  });

  it("validateRecipeV2 returns NAR-CALLBACK-UNDELIVERED for callback openLoop without delivery", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.4";
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      timeline: [{
        segmentId: "seg_body",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 240,
        audioInSec: 0,
        audioOutSec: 240,
        audioPolicy: "from_video_ref",
      }],
    }];
    recipe.creativeMoments = [];

    const timelineIndex = {
      scenes: [
        { sceneId: "clip01_scene001", clipId: "clip01", startSec: 0, endSec: 120 },
        { sceneId: "clip01_scene002", clipId: "clip01", startSec: 120, endSec: 240 },
      ],
    };
    const abstraction = {
      L2: [
        { segmentId: "seg001", sceneIds: ["clip01_scene001"], startSec: 0, endSec: 120 },
        { segmentId: "seg002", sceneIds: ["clip01_scene002"], startSec: 120, endSec: 240 },
      ],
      L3: {
        openLoops: [{
          loopId: "loop_cb",
          kind: "callback",
          setupSceneId: "clip01_scene001",
          payoffSceneId: "clip01_scene002",
        }],
      },
    };

    const result = validateRecipeV2(recipe, { abstraction, timelineIndex });
    assert.ok(result.issues.some((i) => i.code === "NAR-CALLBACK-UNDELIVERED"));
  });

  it("validateRecipeV2 returns V22-VLOG-06 when vlogRetentionProfile disabled", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.version = "2.2";
    recipe.creativityProfile = {
      level: "balanced",
      techniquePack: "youtube_vlog_2026",
    };
    recipe.vlogRetentionProfile = { enabled: false };
    recipe.batchContext.requiredFormats = ["16:9"];
    recipe.outputs = [{
      outputId: "main_16x9",
      format: "16:9",
      outputKind: "main",
      title: "Main",
      targetDurationSec: 720,
      timeline: [{
        segmentId: "m1",
        segmentRole: "aroll",
        videoRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        audioRef: { clipId: "clip01", sceneId: "clip01_scene001" },
        videoInSec: 0,
        videoOutSec: 720,
        audioInSec: 0,
        audioOutSec: 720,
        audioPolicy: "from_video_ref",
        outputEndSec: 720,
      }],
    }];
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

    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((i) => i.code === "V22-VLOG-06" && i.severity === "error"));
    assert.equal(result.issues.filter((i) => i.code === "V22-VLOG-01").length, 0);
    assert.equal(result.issues.filter((i) => i.code === "V22-VLOG-02").length, 0);
  });
});

describe("validateSalvageAndAudioQuality", () => {
  it("flags SALVAGE-01 when salvage_required without salvagePlan", () => {
    const recipe = {
      ...baseRecipe,
      version: "2.5",
      editorialAssessment: {
        verdict: "salvage_required",
        summary: "Materiał wymaga ratunku",
      },
    };
    const result = validateRecipeV2(recipe);
    assert.ok(result.issues.some((issue) => issue.code === "SALVAGE-01"));
  });

  it("flags AUD-QUAL-01 when accept without enhancement manifest", () => {
    const recipe = {
      ...baseRecipe,
      version: "2.5",
      audioEnhancementDecisions: [{
        candidateId: "enh_clip01",
        clipId: "clip01",
        action: "accept",
        dialogueValue: "essential",
        reason: "Wiatr na dialogu",
      }],
    };
    const result = validateRecipeV2(recipe, { audioEnhancementIndex: { clips: [] } });
    assert.ok(result.issues.some((issue) => issue.code === "AUD-QUAL-01"));
  });

  it("flags AUD-QUAL-06 when accept has failed enhancement manifest", () => {
    const recipe = {
      ...baseRecipe,
      version: "2.5",
      audioEnhancementDecisions: [{
        candidateId: "enh_clip01",
        clipId: "clip01",
        action: "accept",
        dialogueValue: "essential",
        reason: "Wiatr na dialogu",
      }],
    };
    const result = validateRecipeV2(recipe, {
      audioEnhancementIndex: {
        clips: [{
          clipId: "clip01",
          status: "failed",
          errorCode: "AUDIO_ENH_DEEPFILTERNET_FAILED",
        }],
      },
    });
    assert.ok(result.issues.some((issue) => issue.code === "AUD-QUAL-06"));
  });
});
