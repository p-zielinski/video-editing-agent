import { z } from "zod";
import { SceneSchema } from "./scene-catalog.js";
import { WordEntrySchema } from "./word-index.js";

export const KeyframeSchema = z.object({
  timestampSec: z.number().nonnegative(),
  sceneId: z.string(),
  trigger: z.enum(["scene_cut", "speech", "motion"]),
  imagePath: z.string().optional(),
});

export const VisionCaptionSchema = z.object({
  timestampSec: z.number().nonnegative(),
  sceneId: z.string(),
  caption: z.string(),
  tags: z.array(z.string()).optional(),
});

export const ObjectDetectionSchema = z.object({
  timestampSec: z.number().nonnegative(),
  sceneId: z.string(),
  label: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const TimelineIndexSchema = z.object({
  version: z.literal("1.0"),
  batchId: z.string(),
  userContext: z.string().optional(),
  clips: z.array(z.object({
    clipId: z.string(),
    sourcePath: z.string(),
    durationSec: z.number().positive(),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "other"]).optional(),
  })),
  scenes: z.array(SceneSchema),
  words: z.array(WordEntrySchema),
  keyframes: z.array(KeyframeSchema).default([]),
  visionCaptions: z.array(VisionCaptionSchema).default([]),
  objectDetections: z.array(ObjectDetectionSchema).default([]),
  stats: z.object({
    totalDurationSec: z.number().nonnegative(),
    totalWords: z.number().int().nonnegative(),
    totalScenes: z.number().int().nonnegative(),
    fillerWordCount: z.number().int().nonnegative(),
  }).optional(),
});
