import { z } from "zod";
import { AnchorTypeSchema } from "./spatial-index.js";
import { PublishVoiceSchema } from "../editorial/publish-voice.js";

export const ProfanityPolicySchema = z.enum(["bleep", "mute", "cut", "off"]);

export const ProfanitySubtitleModeSchema = z.enum(["partial", "full", "off"]);

export const AudioCensorshipWindowSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  mode: z.enum(["bleep", "mute"]),
  wordId: z.string().optional(),
}).refine(
  (window) => window.startSec < window.endSec,
  { message: "audioCensorship: startSec must be less than endSec" },
);

export const AudioPolicyV2Schema = z.enum([
  "from_audio_ref",
  "from_video_ref",
  "from_prev",
  "from_next",
  "external",
  "mute",
]);

export const SyncModeSchema = z.enum([
  "align_start",
  "align_end",
  "fit_video_to_audio",
  "fit_audio_to_video",
  "loop_video",
]);

export const SegmentRoleSchema = z.enum(["aroll", "broll", "ai_hook"]);

export const ClipRoleSchema = z.enum([
  "aroll_primary",
  "aroll_secondary",
  "broll_pool",
  "narration_track",
  "outtakes",
  "undecided",
  "ai_generated",
]);

export const MediaTypeSchema = z.enum(["audio_only", "video"]);

export const RoleSourceSchema = z.enum([
  "clip_profile",
  "l1_refined",
  "context_override",
  "director",
]);

export const VisualQualitySchema = z.enum(["low", "medium", "high"]);

export const MediaRefSchema = z.object({
  clipId: z.string(),
  sceneId: z.string(),
});

export const WordCutSchema = z.object({
  startWordId: z.string(),
  endWordId: z.string(),
  reason: z.string(),
  keepIfStoryCritical: z.boolean().default(false),
});

export const TimeCutSchema = z.object({
  atOutputSec: z.number().nonnegative(),
  gapSec: z.number().min(0.02).max(0.5).default(0.04),
  reason: z.enum(["jump_cut", "hard_cut_energy"]).default("jump_cut"),
  momentId: z.string().optional(),
});

export const PictureInPictureSchema = z.object({
  enabled: z.boolean().default(true),
  sceneId: z.string().optional(),
  position: z.enum(["top_right", "top_left", "bottom_right", "bottom_left"]).default("bottom_right"),
  scale: z.number().min(0.1).max(0.5).default(0.28),
  marginPx: z.number().int().min(0).max(200).default(24),
}).optional();

export const SubtitlePolicyV2Schema = z.enum(["word_by_word", "phrase", "off"]);

export const SubtitlesConfigSchema = z.object({
  policy: SubtitlePolicyV2Schema,
  sourceClipId: z.string(),
  outputStartSec: z.number().nonnegative().optional(),
  outputEndSec: z.number().positive().optional(),
  style: z.string().optional(),
});

export const TextOverlayStyleSchema = z.enum([
  "hook_large",
  "hook_question",
  "hook_number",
  "emphasis",
  "chapter_card",
  "cta",
  "closure_bracket",
  "subtitle_style",
]);

export const TextOverlayRoleSchema = z.enum([
  "hook",
  "retention_beat",
  "payoff",
  "cta",
  "chapter",
  "closure",
]);

export const ShortsOutroBracketSchema = z.object({
  enabled: z.boolean().default(true),
  /** Krótka klamra (max ~40 znaków). Enricher wybierze z L3 gdy brak. */
  text: z.string().min(1).max(48).optional(),
  /** Koniec shorta na osi output (łącznie z klamrą). */
  endAtOutputSec: z.number().positive().optional(),
  bracketDurationSec: z.number().min(1.5).max(4).default(2.5),
  /** Gdy true — enricher szuka słabego ogona i dobiera cut. */
  auto: z.boolean().optional(),
});

export const TextOverlayAnimationSchema = z.enum([
  "fade",
  "static",
  "slide_up",
  "slide_down",
  "slide_left",
  "slide_right",
]);

export const TextOverlayV2Schema = z.object({
  overlayId: z.string().optional(),
  text: z.string(),
  outputStartSec: z.number().nonnegative(),
  outputEndSec: z.number().positive(),
  position: z.string().optional(),
  style: TextOverlayStyleSchema.optional(),
  role: TextOverlayRoleSchema.optional(),
  animation: TextOverlayAnimationSchema.optional(),
});

/** creativeMoments / timeline retention roles; textOverlays use TextOverlayRoleSchema (includes cta). */
export const RetentionRoleSchema = z.enum(["hook", "beat", "payoff", "breath", "closure"]);

export const NarrativeIntentSchema = z.enum([
  "tension",
  "intimacy",
  "isolation",
  "memory",
  "transition",
  "contrast",
  "reveal",
  "momentum",
  "passage_of_time",
  "closure",
]);

export const VideoTransformSchema = z.object({
  crop: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).optional(),
  reframe: z.enum(["center", "face", "subject"]).optional(),
  fitMode: z.enum(["pillarbox", "pillarbox_blur", "fill"]).optional(),
  playbackMode: z.enum(["normal", "reverse", "boomerang"]).default("normal").optional(),
  boomerangHalfSec: z.number().positive().max(30).optional(),
  speed: z.number().positive().max(4).default(1),
  speedMode: z.enum(["video_only", "video_audio"]).default("video_audio"),
}).optional();

export const TimelineSegmentV2Schema = z.object({
  segmentId: z.string(),
  segmentRole: SegmentRoleSchema,
  videoRef: MediaRefSchema,
  audioRef: MediaRefSchema,
  videoInSec: z.number().nonnegative(),
  videoOutSec: z.number().positive(),
  audioInSec: z.number().nonnegative(),
  audioOutSec: z.number().positive(),
  outputStartSec: z.number().nonnegative().optional(),
  outputEndSec: z.number().positive().optional(),
  overlapSec: z.number().nonnegative().default(0),
  audioPolicy: AudioPolicyV2Schema,
  syncMode: SyncModeSchema.default("align_start"),
  allowBrollReuse: z.boolean().default(false),
  cuts: z.array(WordCutSchema).default([]),
  audioCensorship: z.array(AudioCensorshipWindowSchema).default([]),
  timeCuts: z.array(TimeCutSchema).default([]),
  pictureInPicture: PictureInPictureSchema,
  subtitles: SubtitlesConfigSchema.optional(),
  textOverlays: z.array(TextOverlayV2Schema).default([]),
  videoTransform: VideoTransformSchema,
  sourceVolumeDb: z.number().min(-60).max(12).default(0).optional(),
  intent: z.string().optional(),
  retentionRole: RetentionRoleSchema.optional(),
  // deprecated / migration-only — walidator emituje SOURCE_REF_IN_V2_SEGMENT / DEPRECATED_AUDIO_OFFSET
  sourceRef: MediaRefSchema.optional(),
  audioOffsetSec: z.number().optional(),
});

export const ChapterMarkerSchema = z.object({
  title: z.string(),
  startSec: z.number().nonnegative(),
});

export const OutputKindSchema = z.enum(["main", "short"]);

export const AiHookDecisionActionSchema = z.enum(["accept", "reject"]);

export const AiHookDecisionSchema = z.object({
  action: AiHookDecisionActionSchema,
  clipId: z.string().min(1),
  reason: z.string().min(1),
});

export const OutputRecipeV2Schema = z.object({
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
  outputKind: OutputKindSchema.default("main"),
  title: z.string(),
  synopsis: z.string().optional(),
  targetDurationSec: z.number().positive().optional(),
  timeline: z.array(TimelineSegmentV2Schema),
  chapterMarkers: z.array(ChapterMarkerSchema).default([]),
  aiHookDecision: AiHookDecisionSchema.optional(),
});

export const ExclusionTypeSchema = z.enum(["whole_clip", "scene", "time_range"]);

export const ExclusionEntrySchema = z.object({
  clipId: z.string().optional(),
  sceneId: z.string().optional(),
  exclusionType: ExclusionTypeSchema,
  timeRange: z.object({
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
  }).optional(),
  usableAsBroll: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export const ClipRegistryEntrySchema = z.object({
  clipId: z.string(),
  fileName: z.string(),
  durationSec: z.number().positive(),
  sortIndex: z.number().int().nonnegative(),
  creationTime: z.string().nullable().optional(),
  clipRole: ClipRoleSchema,
  roleConfidence: z.number().min(0).max(1).optional(),
  roleSource: RoleSourceSchema.optional(),
  hasSpeech: z.boolean(),
  speechWordCount: z.number().int().nonnegative(),
  visualSummary: z.string().optional(),
  topics: z.array(z.string()).optional(),
  audioTags: z.array(z.string()).optional(),
  visualQuality: VisualQualitySchema.optional(),
  excludeFromMainStory: z.boolean().optional(),
  excludeReason: z.string().nullable().optional(),
  mediaType: MediaTypeSchema.optional(),
});

export const InputModeSchema = z.enum([
  "single_clip",
  "multi_clip_day",
  "multi_clip_collection",
]);

export const BrollStrategySchema = z.enum([
  "match_speech_topics",
  "chronological",
  "director_choice",
  "minimal",
]);

export const BrandSafetySchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(["social_strict", "off"]).default("social_strict"),
  audio: ProfanityPolicySchema.default("bleep"),
  subtitles: ProfanitySubtitleModeSchema.default("partial"),
  overlays: ProfanitySubtitleModeSchema.default("partial"),
  titles: ProfanitySubtitleModeSchema.default("partial"),
  thumbnails: ProfanitySubtitleModeSchema.default("partial"),
  publishText: ProfanitySubtitleModeSchema.default("partial"),
  llmPrompts: z.enum(["masked", "raw"]).default("masked"),
}).default({});

export const BatchContextV2Schema = z.object({
  inputMode: InputModeSchema.optional(),
  theme: z.string().optional(),
  dayLabel: z.string().optional(),
  challengeDay: z.string().optional(),
  targetPlatforms: z.array(z.string()).default([]),
  notes: z.string().optional(),
  qualityOverQuantity: z.boolean().default(true),
  allowWholeClipExclusion: z.boolean().default(true),
  brollStrategy: BrollStrategySchema.default("match_speech_topics"),
  brollMatchThreshold: z.number().min(0).max(1).default(0.55),
  allowBrollReuse: z.boolean().default(false),
  maxBrollSegmentsPerOutput: z.number().int().positive().default(30),
  requiredFormats: z.array(z.enum(["16:9", "9:16"])).min(1).max(2),
  minOutputs: z.array(z.string()).optional(),
  shortsStrategy: z.enum(["standalone_highlights"]).default("standalone_highlights"),
  shortsMaxDurationSec: z.number().positive().default(60),
  publishVoice: PublishVoiceSchema.optional(),
  profanityPolicy: ProfanityPolicySchema.default("bleep"),
  profanitySubtitleMode: ProfanitySubtitleModeSchema.default("partial"),
  brandSafety: BrandSafetySchema,
  aiVideoEnabled: z.boolean().default(false),
  aiVideoMaxPerBatch: z.number().int().positive().default(1),
  aiVideoMaxDurationSec: z.number().positive().max(15).default(5),
  aiVideoGenerateAudio: z.boolean().default(false),
  aiVideoTargetOutputs: z.array(z.enum(["16:9", "9:16"])).default(["9:16"]),
  skipDrillDown: z.boolean().optional(),
  sortBy: z.enum(["mtime", "creation_time", "name"]).optional(),
  musicBed: z.boolean().optional(),
  musicFirst: z.boolean().optional(),
  musicBedTrackId: z.string().optional(),
  targetDurationSec: z.number().positive().optional(),
  formatsSource: z.enum(["cli", "context", "l3", "default"]).optional(),
  superDirectorDurationThresholdSec: z.number().positive().optional(),
  superDirectorMaxSegments: z.number().int().positive().optional(),
  /** When true, always use classic director (single GPT pass) even for long / multi-L2 batches. */
  forceClassicDirector: z.boolean().optional(),
  /** off = never apply LUT/EQ (default, phone SDR); allow = director may set colorGrade. */
  colorGradePolicy: z.enum(["off", "allow"]).default("off"),
});

export const SceneUsageEntrySchema = z.object({
  sceneId: z.string(),
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
});

export const CreativityLevelSchema = z.enum(["safe", "balanced", "bold", "shorts"]);

export const CreativityProfileSchema = z.object({
  level: CreativityLevelSchema.default("balanced"),
  allowMidSentenceCuts: z.boolean().default(false),
  techniquePack: z.string().default("youtube_vlog_2026"),
  maxTechniqueDensityPerMin: z.number().positive().default(0.3),
});

export const SpatialRefSchema = z.object({
  clipId: z.string(),
  sceneId: z.string(),
  /** Anchor time in source clip — optional when bbox + anchorType provided. */
  timestampSec: z.number().nonnegative().optional(),
  anchorType: AnchorTypeSchema.optional(),
  /** Normalized bounding box [x, y, w, h] in 0–1 coordinates (top-left origin). */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
}).refine(
  (ref) => ref.timestampSec != null || (ref.bbox != null && ref.anchorType != null),
  { message: "spatialRef wymaga timestampSec lub (bbox + anchorType)" },
);

export const CreativeMomentSchema = z.object({
  momentId: z.string(),
  techniqueId: z.string(),
  outputId: z.string(),
  outputStartSec: z.number().nonnegative(),
  outputEndSec: z.number().positive(),
  params: z.record(z.unknown()).default({}),
  anchorWordId: z.string().optional(),
  segmentId: z.string().optional(),
  spatialRef: SpatialRefSchema.optional(),
  retentionRole: RetentionRoleSchema.optional(),
  narrativeIntent: NarrativeIntentSchema.optional(),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export const ShortsRetentionProfileSchema = z.object({
  enabled: z.boolean().default(false),
  hookWindowSec: z.number().positive().default(3),
  retentionBeatIntervalSec: z.number().positive().default(25),
  retentionBeatToleranceSec: z.number().nonnegative().default(5),
  minRetentionBeats: z.number().int().nonnegative().default(2),
  requireHookMoment: z.boolean().default(true),
  requireHookOverlay: z.boolean().default(true),
  maxHookOverlayDurationSec: z.number().positive().default(4),
  techniquePack: z.string().default("shorts_retention_2026"),
});

export const VlogRetentionProfileSchema = z.object({
  enabled: z.boolean().default(false),
  hookWindowSec: z.number().positive().default(3),
  retentionBeatIntervalSec: z.number().positive().default(45),
  retentionBeatToleranceSec: z.number().nonnegative().default(8),
  minRetentionBeats: z.number().int().nonnegative().default(2),
  requireHookMoment: z.boolean().default(false),
  requireHookOverlay: z.boolean().default(false),
  techniquePack: z.string().default("youtube_vlog_2026"),
  mode: z.literal("vlog").default("vlog"),
});

export const NarrativeRhythmSchema = z.enum(["slow", "normal", "fast"]);

export const NarrativeRetentionIntensitySchema = z.enum(["low", "medium", "high"]);

export const NarrativeSilencePolicySchema = z.enum([
  "preserve",
  "trim_dead_air",
  "aggressive",
]);

export const NarrativeProfileModeSchema = z.enum([
  "internet_documentary",
  "retention_vlog",
]);

export const NarrativeEnrichPolicySchema = z.object({
  allowRetentionEnrich: z.boolean().default(true),
  allowPacingTrim: z.boolean().default(true),
  allowFillerCuts: z.boolean().default(true),
});

export const NarrativeSegmentProfileSchema = z.object({
  l2SegmentId: z.string(),
  rhythm: NarrativeRhythmSchema.optional(),
  retentionIntensity: NarrativeRetentionIntensitySchema.optional(),
  silencePolicy: NarrativeSilencePolicySchema.optional(),
  enrichPolicy: NarrativeEnrichPolicySchema.optional(),
});

export const NarrativeProfileSchema = z.object({
  mode: NarrativeProfileModeSchema.optional(),
  segments: z.array(NarrativeSegmentProfileSchema).default([]),
  maxPatternInterruptsPer10Min: z.number().nonnegative().optional(),
  sfxNarrativeOnly: z.boolean().optional(),
  /** Global default when a segment omits silencePolicy. */
  silencePolicy: NarrativeSilencePolicySchema.optional(),
});

export const AudioMixMusicBedSchema = z.object({
  trackId: z.string(),
  volumeDb: z.number(),
  duckingDb: z.number(),
});

export const AudioMixDuckingWindowSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  duckingDb: z.number(),
}).refine(
  (window) => window.startSec < window.endSec,
  { message: "duckingWindow: startSec must be less than endSec" },
);

export const AudioMixSegmentSchema = z.object({
  outputId: z.string(),
  musicInSec: z.number().nonnegative().optional(),
  musicOutSec: z.number().positive().optional(),
  duckUnderVoice: z.boolean(),
  /** Per-output override; falls back to musicBed.duckingDb when omitted. */
  duckingDb: z.number().optional(),
  /** Time windows with per-window duck depth (output timeline seconds). */
  duckingWindows: z.array(AudioMixDuckingWindowSchema).max(16).optional(),
});

export const AudioMixPlanSchema = z.object({
  voiceTargetLufs: z.number().default(-16),
  musicBed: AudioMixMusicBedSchema.nullable().default(null),
  preWhisperNormalizeLufs: z.number().default(-18),
  segments: z.array(AudioMixSegmentSchema).default([]),
});

export const SfxPlanSourceSchema = z.enum(["audio_event", "library"]);

export const SfxPlanEntrySchema = z.object({
  sfxId: z.string(),
  source: SfxPlanSourceSchema,
  clipId: z.string().optional(),
  anchorTimeSec: z.number().nonnegative().optional(),
  outputStartSec: z.number().nonnegative(),
  outputEndSec: z.number().positive(),
  volumeDb: z.number().default(-6),
  label: z.string(),
  reason: z.string().optional(),
});

export const ColorGradeSchema = z.object({
  /** When false, renderer skips color grade entirely (e.g. phone SDR footage). */
  enabled: z.boolean().optional(),
  /** none = skip; eq_only = EQ without LUT; lut = EQ + LUT (default). */
  mode: z.enum(["none", "eq_only", "lut"]).optional(),
  lutId: z.string().optional(),
  exposure: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  /** Optional note for director/critic (e.g. display_ready_phone_footage). */
  reason: z.string().optional(),
});

export const SubtitleStylePresetSchema = z.object({
  presetId: z.string(),
  fontFamily: z.string().optional(),
  fontSizePx: z.number().positive().optional(),
  color: z.string().optional(),
  strokeColor: z.string().optional(),
  safeMarginPct: z.number().min(0).max(50).optional(),
});

export const OverlayStylePresetSchema = z.object({
  position: z.string(),
  fontSizePx: z.number().positive().optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional(),
  strokeColor: z.string().optional(),
});

export const FormatRenderPresetSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  safeZone: z.object({
    top: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
    right: z.number().nonnegative(),
  }).optional(),
});

export const RenderStylePresetsSchema = z.object({
  subtitles: SubtitleStylePresetSchema.optional(),
  overlays: z.record(OverlayStylePresetSchema).optional(),
  formats: z.object({
    "16:9": FormatRenderPresetSchema,
    "9:16": FormatRenderPresetSchema,
  }).partial().optional(),
});

export const PacingTrimMetaSchema = z.object({
  segmentsRemoved: z.number().int().nonnegative().default(0),
  deadAirCuts: z.number().int().nonnegative().default(0),
  edgeTrims: z.number().int().nonnegative().default(0),
  exhausted: z.boolean().default(false),
  applied: z.boolean().default(false).optional(),
});

export const RetentionBeatTargetSchema = z.object({
  outputId: z.string(),
  targetSec: z.number().nonnegative(),
  label: z.string().optional(),
});

export const StructuredCallbackSchema = z.object({
  callbackId: z.string(),
  setupSceneId: z.string(),
  payoffSceneId: z.string(),
  teaseText: z.string().optional(),
});

export const EditRecipeV2Schema = z.object({
  version: z.enum(["2.0", "2.1", "2.2", "2.3", "2.4"]),
  batchId: z.string(),
  batchContext: BatchContextV2Schema,
  clipRegistry: z.array(ClipRegistryEntrySchema).default([]),
  outputs: z.array(OutputRecipeV2Schema).min(1),
  excluded: z.array(ExclusionEntrySchema).default([]),
  sceneUsageRegistry: z.array(SceneUsageEntrySchema).default([]),
  creativityProfile: CreativityProfileSchema.optional(),
  creativeMoments: z.array(CreativeMomentSchema).default([]),
  shortsRetentionProfile: ShortsRetentionProfileSchema.optional(),
  vlogRetentionProfile: VlogRetentionProfileSchema.optional(),
  retentionBeatTargets: z.array(RetentionBeatTargetSchema).optional(),
  narrativeProfile: NarrativeProfileSchema.optional(),
  audioMixPlan: AudioMixPlanSchema.optional(),
  sfxPlan: z.array(SfxPlanEntrySchema).default([]),
  colorGrade: ColorGradeSchema.optional(),
  renderStylePresets: RenderStylePresetsSchema.optional(),
  pacingTrimMeta: PacingTrimMetaSchema.optional(),
  shortsOutroBracket: ShortsOutroBracketSchema.optional(),
  shortsOutroBracketMeta: z.object({
    applied: z.boolean(),
    source: z.enum(["director", "enricher"]).optional(),
    contentEndSec: z.number().nonnegative().optional(),
    endAtOutputSec: z.number().positive().optional(),
    text: z.string().optional(),
  }).optional(),
  structuredCallbacks: z.array(StructuredCallbackSchema).default([]).optional(),
  needsHumanReview: z.boolean().default(false),
  reviewNotes: z.string().optional(),
});

// TopicIndex schemas
export const MatchingSceneSchema = z.object({
  sceneId: z.string(),
  score: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export const TopicTimeRangeSchema = z.object({
  clipId: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
});

export const TopicEntrySchema = z.object({
  topicId: z.string(),
  label: z.string(),
  wordIds: z.array(z.string()),
  timeRange: TopicTimeRangeSchema,
  matchingScenes: z.array(MatchingSceneSchema),
});

export const TopicIndexSchema = z.object({
  version: z.enum(["1.0", "2.0"]),
  batchId: z.string(),
  topics: z.array(TopicEntrySchema),
});

export const ClipRegistryArtifactSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  clipRegistry: z.array(ClipRegistryEntrySchema),
});
