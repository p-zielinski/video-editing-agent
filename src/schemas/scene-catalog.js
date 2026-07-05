import { z } from "zod";

export const ResolutionSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

export const AspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:3", "other"]);

export const MediaTypeSchema = z.enum(["audio_only", "video"]);

export const WordRangeSchema = z.object({
  firstWordId: z.string(),
  lastWordId: z.string(),
}).optional();

export const SceneSchema = z.object({
  sceneId: z.string(),
  clipId: z.string(),
  sourcePath: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationSec: z.number().positive(),
  aspectRatio: AspectRatioSchema,
  resolution: ResolutionSchema,
  mediaType: MediaTypeSchema.optional(),
  hasSpeech: z.boolean().default(false),
  wordRange: WordRangeSchema,
  cutScore: z.number().min(0).max(1).optional(),
});

export const SceneCatalogSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  clips: z.array(z.object({
    clipId: z.string(),
    sourcePath: z.string(),
    fileName: z.string(),
    durationSec: z.number().positive(),
    creationTime: z.string().nullable().optional(),
    sortIndex: z.number().int().nonnegative(),
    aspectRatio: AspectRatioSchema.optional(),
    resolution: ResolutionSchema.optional(),
    mediaType: MediaTypeSchema.optional(),
    contentHash: z.string().optional(),
  })),
  scenes: z.array(SceneSchema),
});

export function computeAspectRatio(width, height) {
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.05) {
    return "16:9";
  }
  if (Math.abs(ratio - 9 / 16) < 0.05) {
    return "9:16";
  }
  if (Math.abs(ratio - 1) < 0.05) {
    return "1:1";
  }
  if (Math.abs(ratio - 4 / 3) < 0.05) {
    return "4:3";
  }
  return "other";
}
