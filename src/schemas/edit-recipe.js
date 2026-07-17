import { z } from "zod";

export const AudioPolicySchema = z.enum([
  "source",
  "from_prev",
  "from_next",
  "external",
  "mute",
]);

export const SubtitlePolicySchema = z.enum([
  "word_by_word",
  "sentence",
  "custom",
  "none",
]);

export const SourceRefSchema = z.object({
  clipId: z.string(),
  sceneId: z.string(),
});

export const WordCutSchema = z.object({
  startWordId: z.string(),
  endWordId: z.string(),
  reason: z.string(),
  keepIfStoryCritical: z.boolean().default(false),
});

export const TextOverlaySchema = z.object({
  text: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  position: z.enum(["top", "center", "bottom", "custom"]).default("bottom"),
  safeArea: z.enum(["16:9", "9:16"]).optional(),
});

export const VideoTransformSchema = z.object({
  crop: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }).optional(),
  reframe: z.enum(["center", "face", "subject"]).optional(),
  speed: z.number().positive().default(1),
}).optional();

export const TimelineSegmentSchema = z.object({
  segmentId: z.string(),
  sourceRef: SourceRefSchema,
  videoInSec: z.number().nonnegative(),
  videoOutSec: z.number().positive(),
  audioPolicy: AudioPolicySchema.default("source"),
  audioOffsetSec: z.number().default(0),
  cuts: z.array(WordCutSchema).default([]),
  subtitles: z.object({
    policy: SubtitlePolicySchema,
    customText: z.string().optional(),
    style: z.string().optional(),
  }).optional(),
  textOverlays: z.array(TextOverlaySchema).default([]),
  videoTransform: VideoTransformSchema,
});

export const ChapterMarkerSchema = z.object({
  title: z.string(),
  startSec: z.number().nonnegative(),
});

export const OutputRecipeSchema = z.object({
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
  targetDurationSec: z.number().positive().optional(),
  title: z.string(),
  synopsis: z.string().optional(),
  timeline: z.array(TimelineSegmentSchema),
  chapterMarkers: z.array(ChapterMarkerSchema).default([]),
});

export const ExcludedItemSchema = z.object({
  sceneId: z.string().optional(),
  clipId: z.string().optional(),
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().positive().optional(),
  reason: z.string(),
  confidence: z.number().min(0).max(1).default(0.8),
});

export const SceneUsageEntrySchema = z.object({
  sceneId: z.string(),
  outputId: z.string(),
  format: z.enum(["16:9", "9:16"]),
});

export const BatchContextSchema = z.object({
  theme: z.string().optional(),
  dayLabel: z.string().optional(),
  challengeDay: z.string().optional(),
  targetPlatforms: z.array(z.string()).default([]),
  notes: z.string().optional(),
  qualityOverQuantity: z.boolean().default(true),
});

export const EditRecipeSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  batchContext: BatchContextSchema,
  outputs: z.array(OutputRecipeSchema).min(1),
  excluded: z.array(ExcludedItemSchema).default([]),
  sceneUsageRegistry: z.array(SceneUsageEntrySchema).default([]),
  needsHumanReview: z.boolean().default(false),
  reviewNotes: z.string().optional(),
});

export const VisualQualitySchema = z.enum(["low", "medium", "high"]);
export const StabilitySchema = z.enum(["stable", "shaky", "unknown"]);

export const AbstractL1Schema = z.object({
  sceneId: z.string(),
  summary: z.string(),
  mood: z.string().optional(),
  keyMoments: z.array(z.string()).default([]),
  brollPotential: z.number().min(0).max(1).default(0.5),
  topics: z.array(z.string()).default([]),
  visualQuality: VisualQualitySchema.default("medium"),
  stability: StabilitySchema.default("unknown"),
  isNarrationSource: z.boolean().default(false),
});

export const NarrativeRoleSchema = z.enum([
  "setup",
  "development",
  "tension",
  "breath",
  "climax",
  "payoff",
  "resolution",
  "callback",
]);

export const AbstractL2Schema = z.object({
  segmentId: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  sceneIds: z.array(z.string()),
  summary: z.string(),
  narrativeRole: NarrativeRoleSchema.optional(),
});

export const FormatFitSchema = z.object({
  "16:9": z.number().min(0).max(1).optional(),
  "9:16": z.number().min(0).max(1).optional(),
}).optional();

export const OpenLoopKindSchema = z.enum(["cold_open", "payoff_tease", "callback"]);

export const OpenLoopSchema = z.object({
  loopId: z.string(),
  kind: OpenLoopKindSchema,
  setupSceneId: z.string().optional(),
  payoffSceneId: z.string().optional(),
  teaseText: z.string().optional(),
});

export const HookCreativeBriefStrategySchema = z.enum([
  "contextual",
  "intentionally_unexpected",
]);

export const DEFAULT_HOOK_MUST_AVOID = [
  "text overlays",
  "logos",
  "captions",
  "spoilers",
  "explicit payoff reveal",
];

const HookCreativeBriefCommonFields = {
  narrativePromise: z.string().min(1),
  contextualLink: z.string().min(1),
  mustAvoid: z.array(z.string().min(1)).default(DEFAULT_HOOK_MUST_AVOID),
  visualTone: z.string().min(1).optional(),
};

export const HookCreativeBriefSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("contextual"),
    ...HookCreativeBriefCommonFields,
    unexpectedElement: z.string().min(1).optional(),
  }),
  z.object({
    strategy: z.literal("intentionally_unexpected"),
    ...HookCreativeBriefCommonFields,
    unexpectedElement: z.string().min(1),
  }),
]);

export const EditorialAssessmentVerdictSchema = z.enum([
  "strong",
  "viable",
  "salvageable",
  "not_viable",
]);

export const EditorialConstraintSchema = z.enum([
  "weak_story",
  "missing_context",
  "weak_ending",
  "insufficient_visuals",
  "poor_dialogue_audio",
  "excess_dead_air",
  "repetitive_material",
  "flat_delivery",
]);

export const DeliveryRepairModeSchema = z.enum([
  "editorial_pacing",
  "dsp_polish",
  "localized_emphasis",
  "filler_cuts",
  "voice_resynthesis",
]);

export const DeliveryAssessmentSchema = z.object({
  verdict: z.enum(["engaging", "neutral", "flat"]),
  engagementScore: z.number().min(0).max(1).optional(),
  blockingForRetention: z.boolean().default(false),
  recommendedRepairs: z.array(DeliveryRepairModeSchema).default([]),
  reasoning: z.string().min(1),
});

export const SalvageModeSchema = z.enum([
  "voice_over",
  "broll_montage",
  "audio_enhancement",
  "aggressive_trim",
  "short_only",
  "decline_output",
]);

export const EditorialAssessmentSchema = z.object({
  editabilityScore: z.number().min(0).max(1),
  verdict: EditorialAssessmentVerdictSchema,
  storyCoherenceScore: z.number().min(0).max(1).optional(),
  visualCoverageScore: z.number().min(0).max(1).optional(),
  dialogueValueScore: z.number().min(0).max(1).optional(),
  strengths: z.array(z.string()).default([]),
  constraints: z.array(EditorialConstraintSchema).default([]),
  recommendedSalvageModes: z.array(SalvageModeSchema).default([]),
  reasoning: z.string().min(1),
});

export const AbstractL3Schema = z.object({
  sessionSummary: z.string(),
  narrativeArc: z.string().optional(),
  recommendedFormats: z.array(z.enum(["16:9", "9:16"])).default(["16:9", "9:16"]),
  formatFit: FormatFitSchema,
  estimatedKeepRatio: z.number().min(0).max(1).optional(),
  hasSeparateNarration: z.boolean().default(false),
  openLoops: z.array(OpenLoopSchema).default([]),
  hookCreativeBrief: HookCreativeBriefSchema.optional(),
  editorialAssessment: EditorialAssessmentSchema.optional(),
  deliveryAssessment: DeliveryAssessmentSchema.optional(),
});

export const AbstractionBundleSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  L1: z.array(AbstractL1Schema),
  L2: z.array(AbstractL2Schema),
  L3: AbstractL3Schema,
});

export const ReviewIssueSchema = z.object({
  severity: z.enum(["error", "warning", "suggestion"]),
  code: z.string(),
  message: z.string(),
  outputId: z.string().optional(),
  sceneId: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  iteration: z.number().int().positive(),
  approved: z.boolean(),
  issues: z.array(ReviewIssueSchema).default([]),
  summary: z.string().optional(),
});
