import { z } from "zod";

export const AudioEnhancementManifestSchema = z.object({
  version: z.literal("1.0"),
  candidateId: z.string(),
  clipId: z.string(),
  status: z.enum(["succeeded", "skipped", "failed", "stubbed"]),
  provider: z.string(),
  model: z.string().optional(),
  sourceContentHash: z.string().optional(),
  outputPath: z.string().optional(),
  before: z.object({
    integratedLufs: z.number().nullable().optional(),
    estimatedSnrDb: z.number().nullable().optional(),
    qualityScore: z.number().nullable().optional(),
  }).optional(),
  afterRaw: z.object({
    integratedLufs: z.number().nullable().optional(),
    estimatedSnrDb: z.number().nullable().optional(),
    qualityScore: z.number().nullable().optional(),
  }).optional(),
  normalization: z.object({
    targetLufs: z.number(),
    gainDb: z.number(),
    finalIntegratedLufs: z.number().nullable().optional(),
  }).optional(),
  durationDeltaMs: z.number().optional(),
  sourceVolumeDb: z.number().optional(),
  dspChainApplied: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export const AudioEnhancementIndexSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  clips: z.array(AudioEnhancementManifestSchema),
});
