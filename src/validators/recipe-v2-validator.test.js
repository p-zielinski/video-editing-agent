import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRecipeV2, validateBrollTopicIndex, validateAudioMixPlan, validatePacingGuard } from "./recipe-v2.js";
import { EditRecipeV2Schema } from "../schemas/edit-recipe-v2.js";

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
    assert.ok(result.issues.some((i) => i.code === "BROLL_SCENE_NOT_IN_TOPIC_INDEX"));
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
    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
    assert.ok(!result.issues.some((i) => i.code === "V23-01"));
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
    const issues = validateAudioMixPlan(recipe);
    assert.ok(issues.some((i) => i.code === "V23-01"));
    assert.equal(issues[0].severity, "warning");
  });

  it("warns V24-01 when main output exceeds source duration with qualityOverQuantity", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.qualityOverQuantity = true;
    recipe.outputs[0].timeline[0].videoOutSec = 160;
    recipe.outputs[0].timeline[0].audioOutSec = 160;

    const issues = validatePacingGuard(recipe);
    assert.ok(issues.some((i) => i.code === "V24-01"));
    assert.equal(issues[0].severity, "warning");

    const result = validateRecipeV2(recipe);
    assert.equal(result.valid, true);
    assert.ok(result.issues.some((i) => i.code === "V24-01"));
  });

  it("warns V24-01 when main output exceeds L3 estimatedKeepRatio budget", () => {
    const recipe = structuredClone(baseRecipe);
    recipe.batchContext.qualityOverQuantity = false;
    recipe.outputs[0].timeline[0].videoOutSec = 60;
    recipe.outputs[0].timeline[0].audioOutSec = 60;

    const issues = validatePacingGuard(recipe, { estimatedKeepRatio: 0.35 });
    assert.ok(issues.some((i) => i.code === "V24-01"));
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
});
