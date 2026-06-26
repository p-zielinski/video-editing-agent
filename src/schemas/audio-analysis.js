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

export const ClipAudioAnalysisSchema = z.object({
  version: z.literal("1.0"),
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
});

export const AudioIndexClipSummarySchema = z.object({
  clipId: z.string(),
  voiceLufs: z.number().nullable(),
  beatCount: z.number().int().nonnegative(),
  silenceGapCount: z.number().int().nonnegative(),
  totalSilenceSec: z.number().nonnegative(),
  recommendedTrackId: z.string().nullable().optional(),
  estimatedBpm: z.number().positive().optional(),
  beatTimes: z.array(z.number().nonnegative()).default([]),
  audioEventCount: z.number().int().nonnegative().default(0),
  editorialTags: z.array(z.string()).default([]),
  eventDetectionMode: AudioEventDetectionModeSchema.optional(),
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
  bpm: z.number().positive(),
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
