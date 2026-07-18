import { z } from "zod";

export const EnergyCurvePointSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  rmsDb: z.number(),
});

export const SilenceGapSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
});

export const BeatMarkerSchema = z.object({
  timeSec: z.number().nonnegative(),
  strength: z.number().min(0).max(1),
});

export const CutSuggestionSchema = z.object({
  timeSec: z.number().nonnegative(),
  reason: z.string(),
  strength: z.number().min(0).max(1).optional(),
});

export const MusicBedRecommendationSchema = z.object({
  mood: z.string(),
  trackId: z.string().optional(),
  bpm: z.number().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const AudioAnalysisModeSchema = z.enum([
  "librosa",
  "ffmpeg",
  "ffmpeg_astats",
  "stub",
  "speech_onsets",
  "musical_beats",
  "musical_onsets",
]);

export const AudioEventDetectionModeSchema = z.enum(["panns", "stub", "none"]);

export const AudioEventSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  label: z.string(),
  score: z.number().min(0).max(1),
  editorialTag: z.string().optional(),
  category: z.string().optional(),
});

export const EditorialAudioTagSchema = z.object({
  tag: z.string(),
  category: z.string().optional(),
  count: z.number().int().nonnegative(),
  peakScore: z.number().min(0).max(1),
  totalDurationSec: z.number().nonnegative(),
});

export const AudioQualityGradeSchema = z.enum(["good", "usable", "poor", "unusable"]);

export const DeliveryIssueSchema = z.enum([
  "flat_pitch",
  "steady_energy",
  "steady_pace",
  "high_fillers",
]);

export const EngagementGradeSchema = z.enum(["engaging", "neutral", "flat"]);

export const DeliveryWindowSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  f0SemitoneSd: z.number().nonnegative().optional(),
  loudnessModulation: z.number().min(0).optional(),
  wpm: z.number().positive().optional(),
  pauseRatio: z.number().min(0).max(1).optional(),
  voicedRatio: z.number().min(0).max(1).optional(),
  engagementScore: z.number().min(0).max(1),
  issues: z.array(DeliveryIssueSchema).default([]),
});

export const FlatDeliveryWindowSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  engagementScore: z.number().min(0).max(1),
  issues: z.array(DeliveryIssueSchema).default([]),
});

export const DeliveryClipSummarySchema = z.object({
  engagementGrade: EngagementGradeSchema,
  engagementScore: z.number().min(0).max(1),
  dominantIssues: z.array(z.string()).default([]),
  flatWindowCount: z.number().int().nonnegative().default(0),
  flatDeliveryWindows: z.array(FlatDeliveryWindowSchema).default([]),
});

export const DeliveryAnalysisSchema = z.object({
  assessmentVersion: z.literal("1.0"),
  mode: z.enum(["heuristic", "hybrid", "stub"]),
  windows: z.array(DeliveryWindowSchema).default([]),
  clipSummary: DeliveryClipSummarySchema,
});

export const AudioQualitySchema = z.object({
  assessmentVersion: z.literal("1.0"),
  mode: z.enum(["heuristic", "ml", "hybrid", "stub"]),
  hasSpeech: z.boolean(),
  speechPresenceRatio: z.number().min(0).max(1).optional(),
  estimatedSnrDb: z.number().nullable().optional(),
  noiseFloorDbfs: z.number().nullable().optional(),
  clippingRatio: z.number().min(0).max(1).optional(),
  windScore: z.number().min(0).max(1).optional(),
  humScore: z.number().min(0).max(1).optional(),
  speechClarityScore: z.number().min(0).max(1).nullable().optional(),
  qualityScore: z.number().min(0).max(1),
  grade: AudioQualityGradeSchema,
  issues: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
  enhancementRecommended: z.boolean(),
  enhancementCandidateId: z.string().optional(),
  reasons: z.array(z.string()).default([]),
});

export const ClipAudioAnalysisSchema = z.object({
  version: z.enum(["1.0", "1.1"]),
  clipId: z.string(),
  durationSec: z.number().positive(),
  voiceLufs: z.number().nullable(),
  energyCurve: z.array(EnergyCurvePointSchema).default([]),
  silenceGaps: z.array(SilenceGapSchema).default([]),
  beats: z.array(BeatMarkerSchema).default([]),
  musicBedRecommendation: MusicBedRecommendationSchema.nullable().optional(),
  cutSuggestions: z.array(CutSuggestionSchema).default([]),
  analysisMode: AudioAnalysisModeSchema,
  estimatedBpm: z.number().positive().nullable().optional(),
  audioEvents: z.array(AudioEventSchema).default([]),
  editorialTags: z.array(EditorialAudioTagSchema).default([]),
  eventDetectionMode: AudioEventDetectionModeSchema.optional(),
  audioQuality: AudioQualitySchema.optional(),
  deliveryAnalysis: DeliveryAnalysisSchema.optional(),
});

export const AudioIndexClipSummarySchema = z.object({
  clipId: z.string(),
  voiceLufs: z.number().nullable(),
  beatCount: z.number().int().nonnegative(),
  silenceGapCount: z.number().int().nonnegative(),
  totalSilenceSec: z.number().nonnegative(),
  recommendedTrackId: z.string().nullable().optional(),
  estimatedBpm: z.number().positive().nullable().optional(),
  beatTimes: z.array(z.number().nonnegative()).default([]),
  audioEventCount: z.number().int().nonnegative().default(0),
  editorialTags: z.array(z.string()).default([]),
  eventDetectionMode: AudioEventDetectionModeSchema.optional(),
  audioQualityGrade: AudioQualityGradeSchema.optional(),
  audioQualityScore: z.number().min(0).max(1).optional(),
  estimatedSnrDb: z.number().nullable().optional(),
  windScore: z.number().min(0).max(1).optional(),
  enhancementCandidateId: z.string().nullable().optional(),
  deliveryGrade: EngagementGradeSchema.optional(),
  deliveryScore: z.number().min(0).max(1).optional(),
  deliveryDominantIssues: z.array(z.string()).default([]),
  flatDeliveryWindowCount: z.number().int().nonnegative().optional(),
});

export const AudioIndexBatchSummarySchema = z.object({
  avgVoiceLufs: z.number().nullable(),
  totalSilenceSec: z.number().nonnegative(),
  dominantMood: z.string().optional(),
  estimatedBpm: z.number().positive().optional(),
  clipCount: z.number().int().nonnegative(),
  eventDetectionMode: AudioEventDetectionModeSchema.optional(),
});

export const MusicLibraryTrackRefSchema = z.object({
  trackId: z.string(),
  mood: z.array(z.string()),
  bpm: z.number().positive().optional(),
});

export const AudioIndexSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  clips: z.array(AudioIndexClipSummarySchema),
  batchSummary: AudioIndexBatchSummarySchema,
  musicLibrary: z.object({
    trackCount: z.number().int().nonnegative(),
    tracks: z.array(MusicLibraryTrackRefSchema).default([]),
  }),
});
