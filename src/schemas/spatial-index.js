import { z } from "zod";

export const AnchorTypeSchema = z.enum(["face", "subject", "object"]);

export const SpatialAnchorSchema = z.object({
  type: AnchorTypeSchema,
  /** Normalized bounding box [x, y, w, h] in 0–1 coordinates (top-left origin). */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  timestampSec: z.number().nonnegative(),
  label: z.string(),
  confidence: z.number().min(0).max(1),
});

export const SceneSpatialEntrySchema = z.object({
  sceneId: z.string(),
  clipId: z.string().optional(),
  anchors: z.array(SpatialAnchorSchema).default([]),
});

export const SpatialIndexBuiltFromSchema = z.object({
  timelineIndexMtime: z.number().nullable(),
  objectDetectionCount: z.number().int().nonnegative(),
  faceDetectionCount: z.number().int().nonnegative().optional(),
});

export const SpatialIndexSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  scenes: z.array(SceneSpatialEntrySchema),
  builtFrom: SpatialIndexBuiltFromSchema.optional(),
});
