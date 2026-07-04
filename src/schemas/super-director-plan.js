import { z } from "zod";
import { CreativityProfileSchema, NarrativeProfileSchema } from "./edit-recipe-v2.js";

export const SegmentPickSchema = z.object({
  segmentId: z.string(),
  priority: z.number().int().min(1).max(10),
  targetKeepRatio: z.number().min(0).max(1).optional(),
});

export const CrossSegmentCallbackSchema = z.object({
  callbackId: z.string(),
  setupSceneId: z.string(),
  payoffSceneId: z.string(),
  teaseText: z.string().optional(),
});

export const SuperDirectorPlanSchema = z.object({
  segmentOrder: z.array(z.string()).default([]),
  segmentPicks: z.array(SegmentPickSchema).default([]),
  crossSegmentCallbacks: z.array(CrossSegmentCallbackSchema).default([]),
  crossSegmentNotes: z.array(z.string()).default([]),
  shortsSources: z.array(z.string()).default([]),
  globalTheme: z.string().optional(),
  creativityProfile: CreativityProfileSchema.optional(),
  narrativeProfile: NarrativeProfileSchema.optional(),
  excludedClips: z.array(z.string()).default([]),
});
