/**
 * Director prompt output schema — superset of EditRecipeV2 fields the director may emit.
 * Used in GPT prompts; validated downstream by EditRecipeV2Schema (Zod).
 */

const SPATIAL_REF_EXAMPLE = {
  clipId: "string",
  sceneId: "string",
  timestampSec: 0,
  anchorType: "face|subject|object",
  bbox: [0.1, 0.2, 0.3, 0.4],
};

const TIMELINE_SEGMENT_EXAMPLE = {
  segmentId: "string",
  segmentRole: "aroll|broll|ai_hook",
  videoRef: { clipId: "string", sceneId: "string" },
  audioRef: { clipId: "string", sceneId: "string" },
  videoInSec: 0,
  videoOutSec: 10,
  audioInSec: 0,
  audioOutSec: 10,
  outputStartSec: 0,
  outputEndSec: 10,
  audioPolicy: "from_video_ref|from_audio_ref|from_prev|from_next|external|mute",
  syncMode: "align_start|align_end|fit_video_to_audio|fit_audio_to_video|loop_video",
  overlapSec: 0,
  allowBrollReuse: false,
  cuts: [
    { startWordId: "string", endWordId: "string", reason: "string", keepIfStoryCritical: false },
  ],
  timeCuts: [
    { atOutputSec: 5, gapSec: 0.04, reason: "jump_cut|hard_cut_energy", momentId: "string?" },
  ],
  pictureInPicture: {
    enabled: true,
    sceneId: "string?",
    position: "top_right|top_left|bottom_right|bottom_left",
    scale: 0.28,
    marginPx: 24,
  },
  subtitles: {
    policy: "word_by_word|phrase|off",
    sourceClipId: "string",
    outputStartSec: 0,
    outputEndSec: 10,
    style: "string?",
  },
  textOverlays: [
    {
      overlayId: "string?",
      text: "string",
      outputStartSec: 0,
      outputEndSec: 3,
      position: "string?",
      style: "hook_large|hook_question|emphasis|chapter_card|cta|closure_bracket",
      role: "hook|retention_beat|payoff|cta|chapter|closure",
      animation: "fade|static|slide_up|slide_down|slide_left|slide_right",
    },
  ],
  videoTransform: {
    speed: 1,
    speedMode: "video_audio|video_only",
    reframe: "center|face|subject?",
    fitMode: "pillarbox|pillarbox_blur|fill?",
  },
  sourceVolumeDb: 0,
  intent: "string?",
  retentionRole: "hook|beat|payoff|breath|closure?",
};

export const EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA = {
  version: "2.5",
  batchId: "string",
  batchContext: {
    inputMode: "single_clip|multi_clip_day|multi_clip_collection",
    theme: "string?",
    dayLabel: "string?",
    challengeDay: "string?",
    targetPlatforms: ["youtube", "shorts"],
    notes: "string?",
    requiredFormats: ["16:9", "9:16"],
    brollStrategy: "match_speech_topics|chronological|director_choice|minimal",
    brollMatchThreshold: 0.55,
    qualityOverQuantity: true,
    allowWholeClipExclusion: true,
    allowBrollReuse: false,
    maxBrollSegmentsPerOutput: 30,
    shortsStrategy: "standalone_highlights",
    shortsMaxDurationSec: 60,
    minOutputs: ["string?"],
    publishVoice: { tone: "string?", audience: "string?" },
  },
  creativityProfile: {
    level: "safe|balanced|bold|shorts",
    allowMidSentenceCuts: false,
    techniquePack: "youtube_vlog_2026",
    maxTechniqueDensityPerMin: 0.3,
  },
  creativeMoments: [
    {
      momentId: "cm_001",
      techniqueId: "zoom_punch_in",
      outputId: "string",
      outputStartSec: 0,
      outputEndSec: 2.5,
      params: {},
      anchorWordId: "string?",
      segmentId: "string?",
      spatialRef: SPATIAL_REF_EXAMPLE,
      retentionRole: "hook|beat|payoff|breath|closure?",
      narrativeIntent: "tension|intimacy|isolation|memory|transition|contrast|reveal|momentum|passage_of_time|closure?",
      reason: "string",
      confidence: 0.85,
    },
  ],
  shortsRetentionProfile: {
    enabled: true,
    hookWindowSec: 3,
    retentionBeatIntervalSec: 25,
    retentionBeatToleranceSec: 5,
    minRetentionBeats: 2,
    requireHookMoment: true,
    requireHookOverlay: true,
    maxHookOverlayDurationSec: 4,
    techniquePack: "shorts_retention_2026",
  },
  shortsOutroBracket: {
    enabled: true,
    text: "string? (max ~40 znaków)",
    endAtOutputSec: 28,
    bracketDurationSec: 2.5,
    auto: false,
  },
  vlogRetentionProfile: {
    enabled: false,
    hookWindowSec: 3,
    retentionBeatIntervalSec: 45,
    requireHookMoment: false,
    requireHookOverlay: false,
    techniquePack: "youtube_vlog_2026",
    mode: "vlog",
  },
  narrativeProfile: {
    mode: "internet_documentary|retention_vlog",
    segments: [
      {
        l2SegmentId: "string",
        rhythm: "slow|normal|fast",
        retentionIntensity: "low|medium|high",
        silencePolicy: "preserve|trim_dead_air|aggressive",
      },
    ],
    silencePolicy: "preserve|trim_dead_air|aggressive",
    sfxNarrativeOnly: false,
  },
  retentionBeatTargets: [
    { outputId: "string", targetSec: 25, label: "string?" },
  ],
  audioMixPlan: {
    voiceTargetLufs: -16,
    musicBed: {
      trackId: "string",
      volumeDb: -18,
      duckingDb: -12,
    },
    preWhisperNormalizeLufs: -18,
    segments: [
      {
        outputId: "string",
        musicInSec: 0,
        musicOutSec: 120,
        duckUnderVoice: true,
        duckingDb: -12,
        duckingWindows: [
          { startSec: 0, endSec: 30, duckingDb: -12 },
        ],
      },
    ],
  },
  sfxPlan: [
    {
      sfxId: "string",
      source: "audio_event|library",
      clipId: "string?",
      anchorTimeSec: 0,
      outputStartSec: 0,
      outputEndSec: 1,
      volumeDb: -6,
      label: "string",
      reason: "string?",
    },
  ],
  colorGrade: {
    enabled: true,
    mode: "none|eq_only|lut",
    lutId: "string?",
    exposure: 0,
    contrast: 0,
    saturation: 0,
    reason: "string?",
  },
  structuredCallbacks: [
    {
      callbackId: "string",
      setupSceneId: "string",
      payoffSceneId: "string",
      teaseText: "string?",
    },
  ],
  editorialAssessment: {
    verdict: "publishable_as_is|salvage_required|not_recommended",
    confidence: "0-1 (optional)",
    summary: "string — krytyczna ocena materiału",
    strengths: ["string"],
    blockingIssues: ["string"],
  },
  salvagePlan: {
    status: "not_needed|proposed|materializable|blocked",
    primaryStrategy: "voice_over|broll_montage|audio_enhancement|hybrid|short_only|decline_output",
    reason: "string",
    targetOutputIds: ["outputId"],
    requiresHumanApproval: true,
    voiceOverProposal: {
      purpose: "string",
      scriptOutline: ["string — punkty narracji"],
      estimatedDurationSec: 45,
      coverageSceneIds: ["sceneId"],
      preferredSource: "user_recorded|existing_narration|tts",
      materializationStatus: "available|missing_narration|out_of_scope",
    },
  },
  audioEnhancementDecisions: [
    {
      candidateId: "enh_clip01 — from audioQuality.enhancementCandidateId",
      clipId: "clip01",
      action: "accept|reject",
      dialogueValue: "essential|useful|dispensable",
      reason: "string",
      providerPreference: "auto|local|paid",
      targetDialogueLufs: -18,
      retranscribePolicy: "never|if_material_improvement|always",
    },
  ],
  clipRegistry: [],
  outputs: [
    {
      outputId: "string",
      format: "16:9|9:16",
      outputKind: "main|short",
      title: "string",
      synopsis: "string?",
      targetDurationSec: 600,
      chapterMarkers: [{ title: "string", startSec: 0 }],
      aiHookDecision: {
        action: "accept|reject",
        clipId: "string — must match brief.aiHook.clipId when accepting",
        reason: "string — explicit rationale for accept or reject",
      },
      timeline: [TIMELINE_SEGMENT_EXAMPLE],
    },
  ],
  excluded: [
    {
      exclusionType: "whole_clip|scene|time_range",
      clipId: "string?",
      sceneId: "string?",
      timeRange: { startSec: 0, endSec: 10 },
      usableAsBroll: false,
      reason: "string",
      confidence: 0.9,
    },
  ],
  sceneUsageRegistry: [],
};

/** @deprecated Use EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA — kept for tests and segment-director. */
export const EDIT_RECIPE_V2_OUTPUT_SCHEMA = EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA;

export function buildDirectorOutputSchema() {
  return structuredClone(EDIT_RECIPE_DIRECTOR_OUTPUT_SCHEMA);
}
