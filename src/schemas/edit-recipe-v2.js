import { z } from "zod";
import { AnchorTypeSchema } from "./spatial-index.js";
import { PublishVoiceSchema } from "../editorial/publish-voice.js";

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

export const SegmentRoleSchema = z.enum(["aroll", "broll"]);

export const ClipRoleSchema = z.enum([
  "aroll_primary",
  "aroll_secondary",
  "broll_pool",
  "narration_track",
  "outtakes",
  "undecided",
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
  "subtitle_style",
]);

export const TextOverlayRoleSchema = z.enum([
  "hook",
  "retention_beat",
  "payoff",
  "cta",
  "chapter",
]);

export const TextOverlayV2Schema = z.object({
  overlayId: z.string().optional(),
  text: z.string(),
  outputStartSec: z.number().nonnegative(),
  outputEndSec: z.number().positive(),
  position: z.string().optional(),
  style: TextOverlayStyleSchema.optional(),
  role: TextOverlayRoleSchema.optional(),
});

export const VideoTransformSchema = z.object({
  crop: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).optional(),
  reframe: z.enum(["center", "face", "subject"]).optional(),
  fitMode: z.enum(["pillarbox", "fill"]).optional(),
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
  subtitles: SubtitlesConfigSchema.optional(),
  textOverlays: z.array(TextOverlayV2Schema).default([]),
  videoTransform: VideoTransformSchema,
  sourceVolumeDb: z.number().min(-60).max(12).default(0).optional(),
  intent: z.string().optional(),
  // deprecated / migration-only — walidator emituje SOURCE_REF_IN_V2_SEGMENT / DEPRECATED_AUDIO_OFFSET
  sourceRef: MediaRefSchema.optional(),
  audioOffsetSec: z.number().optional(),
});

export const ChapterMarkerSchema = z.object({
  title: z.string(),
  startSec: z.number().nonnegative(),
});

export const OutputKindSchema = z.enum(["main", "short"]);

export const OutputRecipeV2Schema = z.object({
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
  outputKind: OutputKindSchema.default("main"),
  title: z.string(),
  synopsis: z.string().optional(),
  targetDurationSec: z.number().positive().optional(),
  timeline: z.array(TimelineSegmentV2Schema),
  chapterMarkers: z.array(ChapterMarkerSchema).default([]),
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

/** creativeMoments retention roles; textOverlays use TextOverlayRoleSchema (includes cta). */
export const RetentionRoleSchema = z.enum(["hook", "beat", "payoff"]);

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

export const AudioMixMusicBedSchema = z.object({
  trackId: z.string(),
  volumeDb: z.number(),
  duckingDb: z.number(),
});

export const AudioMixSegmentSchema = z.object({
  outputId: z.string(),
  musicInSec: z.number().nonnegative().optional(),
  musicOutSec: z.number().positive().optional(),
  duckUnderVoice: z.boolean(),
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
  audioMixPlan: AudioMixPlanSchema.optional(),
  sfxPlan: z.array(SfxPlanEntrySchema).default([]),
  colorGrade: ColorGradeSchema.optional(),
  renderStylePresets: RenderStylePresetsSchema.optional(),
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
